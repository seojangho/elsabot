const https = require('https')
const { stringify } = require('querystring')
const { parse, serialize } = require('cookie')
const { spawn } = require('child_process')

class ConsolePreview {
  constructor (timeStamp, png) {
    this.timeStamp = timeStamp
    this.png = png
  }
}

class Response {
  constructor (statusCode, headers, body) {
    this.statusCode = statusCode
    this.headers = headers
    this.body = body
  }
}

function request (host, path, cookie, requestBody) {
  return new Promise((resolve, reject) => {
    const requestBodyString = requestBody === undefined ? undefined : stringify(requestBody)
    const serializedCookies = []
    for (const cookieName in cookie) {
      serializedCookies.push(serialize(cookieName, cookie[cookieName]))
    }
    const options = {
      host: host,
      port: 443,
      path: path,
      method: requestBody === undefined ? 'GET' : 'POST',
      rejectUnauthorized: false,
      headers: {
        Cookie: serializedCookies.join('; ')
      },
      timeout: 20000
    }
    if (requestBody !== undefined) {
      options.headers['Content-Length'] = requestBodyString.length
    }
    options.agent = new https.Agent(options)
    const responseBody = []
    const request = https.request(options, response => {
      response.on('data', chunk => responseBody.push(chunk))
      response.on('end', () => resolve(new Response(
        response.statusCode, response.headers, Buffer.concat(responseBody))))
      response.on('error', error => reject(error))
    })
    request.on('error', error => reject(error))
    request.on('timeout', () => reject(new Error('Timeout')))
    if (requestBody !== undefined) {
      request.write(requestBodyString)
    }
    request.end()
  })
}

async function preview (host, username, password) {
  const cookie = await login(host, username, password)
  await request(host, '/cgi/upgrade_process.cgi', cookie, { 'fwtype': 255, 'time_stamp': (new Date()).toString() })
  const timeStamp = new Date()
  await request(host, '/cgi/CapturePreview.cgi', cookie, { 'IKVM_PREVIEW.XML': '(0,0)', 'time_stamp': timeStamp.toString() })
  await sleep(3000)
  const response = await request(host, '/cgi/url_redirect.cgi?' + stringify({
    'url_name': 'Snapshot',
    'url_type': 'img',
    'time_stamp': (new Date()).toString()
  }), cookie)
  if (response.statusCode !== 200) {
    throw new Error(`StatusCode is ${response.statusCode}`)
  }
  const png = await bmpToPng(response.body)
  return new ConsolePreview(timeStamp, png)
}

function bmpToPng (bmp) {
  return new Promise((resolve, reject) => {
    const png = []
    const convert = spawn('convert', ['-', 'png:-'])
    convert.stdout.on('data', chunk => png.push(chunk))
    convert.on('close', code => {
      if (code === 0) {
        resolve(Buffer.concat(png))
      } else {
        reject(new Error(`Imagemgaick StatusCode is ${code}`))
      }
    })
    convert.on('error', error => reject(error))
    convert.stdin.write(bmp)
    convert.stdin.end()
  })
}

async function login (host, username, password) {
  const response = await request(host, '/cgi/login.cgi', {}, { 'name': username, 'pwd': password })
  const setCookie = response.headers['set-cookie']
  if (setCookie === undefined) {
    throw new Error(`Cannot login to ${host} as ${username}`)
  }
  for (const cookie of setCookie) {
    const parsedCookie = parse(cookie)
    if (parsedCookie.SID) {
      parsedCookie.langSetFlag = 0
      parsedCookie.language = 'English'
      parsedCookie.mainpage = 'system'
      parsedCookie.subpage = 'top'
      return parsedCookie
    }
  }
}

function sleep (ms) {
  return new Promise((resolve, reject) => {
    setTimeout(() => resolve(), ms)
  })
}

exports.preview = preview

// const fs = require('fs');
// preview('147.46.215.217', 'admin', '').then(x => fs.writeFile('./x', x.png, (err) => console.log(err))).catch(x => console.error(x));
