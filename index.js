const { WebClient } = require('@slack/client');
const uuidv4 = require('uuid/v4');
const http = require('http');

class SleepingElsa {
    constructor(elsaId, callbackId) {
        this.elsaId = elsaId;
        this.callbackId = callbackId;
        this.messageTs = null;
    }

    get elsaIdentifier() {
        return 'Elsa-' + ('0' + this.elsaId).slice(-2);
    }

    get sleepNotification() {
        return {
            attachments: [
              {
                'color': '#aaaaaa',
                'title': `${this.elsaIdentifier} is sleeping`,
                'text': 'SSH is not responsive for last 2 minutes.',
                'actions': [{
                    'name': 'reset',
                    'value': 'reset',
                    'text': 'Force Reboot',
                    'type': 'button'
                }],
                'callback_id': this.callbackId
              }
            ]
          }
    }

    requestedNotification(username) {
        return {
            attachments: [
              {
                'color': '#aaaaaa',
                'title': `${this.elsaIdentifier} is sleeping`,
                'text': 'SSH is not responsive for last 2 minutes.' + `\n:white_check_mark: @${username} knocks the door!`,
                'callback_id': this.callbackId
              }
            ]
          }
    }
}

class BotState {
    constructor() {
        this.elsaIdMap = [];
        this.callbackIdMap = {};
    }

    tryRemoveByCallbackId(callbackId) {
        const elsa = this.callbackIdMap[callbackId];
        if (elsa === undefined) {
            return undefined;
        }
        delete this.elsaIdMap[elsa.elsaId];
        delete this.callbackIdMap[callbackId];
        return elsa;
    }

    tryAddByElsaId(elsaId) {
        if (this.elsaIdMap[elsaId] !== undefined) {
            return undefined;
        }
        const elsa = new SleepingElsa(elsaId, uuidv4());
        this.elsaIdMap[elsaId] = elsa;
        this.callbackIdMap[elsa.callbackId] = elsa;
        return elsa;
    }
}

const token = process.env.SLACK_TOKEN;
const channelId = process.env.SLACK_CHANNEL;
const port = process.env.PORT;
const botState = new BotState();
const web = new WebClient(token);

http.createServer((req, res) => {
    const body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', () => {
        const data = Buffer.concat(body).toString();
        console.log(JSON.parse(data));
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain');
        res.end('\n');
    });
}).listen(port, '127.0.0.1');

async function sleepingElsaDetected(elsaId) {
    const elsa = botState.tryAddByElsaId(elsaId);
    if (elsa === undefined) {
        return;
    }
    return await web.chat.postMessage(channelId, '', elsa.sleepNotification);
}

async function rebootRequested(callbackId, username) {
    const elsa = botState.tryRemoveByCallbackId(callbackId);
    if (elsa == undefined) {
        return;
    }
}