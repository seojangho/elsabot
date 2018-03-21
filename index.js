const { WebClient } = require('@slack/client');
const { RtmClient } = require('@slack/client');
const { createMessageAdapter } = require('@slack/interactive-messages');
const uuidv4 = require('uuid/v4');
const { readFileSync } = require('fs');
const { exec } = require('child_process');
const { createServer } = require('http');
const { preview } = require('./preview');
const Koa = require('koa');
const koaRoute = require('koa-route');

const HostStatus = {
    UNKNOWN: 0,
    TESTING_REBOOT: 1,
    NORMAL: 2,
    DOWN: 3,
    WAITING_REBOOT: 4
};

class TimedValue {
    constructor(initialValue) {
        this.value = initialValue;
    }

    get value() {
        return this._value;
    }

    set value(newValue) {
        this._value = newValue;
        this._timestamp = Math.floor(new Date() / 1000);
    }

    get timestamp() {
        return this._timestamp;
    }

    get timeFormatting() {
        return `<!date^${this.timestamp}^{date_pretty} {time_secs}|${this.timestamp}>`;
    }
}

class Host {
    constructor(hostId, pingHost, ipmiHost, ipmiPassword) {
        this.hostId = hostId;
        this.pingHost = pingHost;
        this.ipmiHost = ipmiHost;
        this.ipmiPassword = ipmiPassword;

        this.supervised = globalSupervised;
        this.status = new TimedValue(HostStatus.UNKNOWN);
        this.pingFailures = 0;
        this.timeout = null;
        this.consolePreview = null;
    }

    get consolePreviewNeeded() {
        if (!this.ipmiHost) {
          return false;
        }
        return this.status.value === HostStatus.DOWN || this.status.value === HostStatus.TESTING_REBOOT || this.status.value === HostStatus.WAITING_REBOOT;
    }

    async heartbeat() {
        try {
            await system(`ping -c${pingConfig['count']} -w${pingConfig['deadline']} ${this.pingHost}`);
            this.pingFailures = 0;
            await this.post(await this.transition(HostStatus.NORMAL));
        } catch (e) {
            if (this.status.value === HostStatus.WAITING_REBOOT) {
                await this.post(false);
                return;
            }
            console.error(e);
            this.pingFailures++;
            if (this.pingFailures === pingConfig['num_trials_before_down']) {
                await this.post(await this.transition(HostStatus.DOWN));
            } else {
                await this.post(false);
            }
        }
    }

    async post(forced) {
        let willPost = forced;
        const messageCard = messageCards.tryGetByHostId(this.hostId);
        if (messageCard === undefined) {
            return;
        }
        if (this.consolePreviewNeeded) {
            if (messageCard.consolePreview !== this.consolePreview) {
                messageCard.consolePreview = this.consolePreview;
                willPost = true;
            }
        } else {
            if (messageCard.consolePreview) {
                messageCard.consolePreview = null;
                willPost = true;
            }
        }
        if (willPost) {
            await messageCard.post();
        }
    }

    async transition(newStatus) {
        const oldStatus = this.status.value;
        const oldConsolePreviewNeeded = this.consolePreviewNeeded;
        if (oldStatus === newStatus) {
            return false;
        }
        this.status.value = newStatus;
        const newConsolePreviewNeeded = this.consolePreviewNeeded;
        if (!oldConsolePreviewNeeded && newConsolePreviewNeeded) {
            consolePreviewUpdate(this).catch(error => console.error(error));
        }
        this.pingFailures = 0;
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }
        const messageCard = messageCards.tryGetByHostId(this.hostId);
        if (messageCard !== undefined) {
            messageCard.status.value = newStatus;
        }
        switch (newStatus) {
            case HostStatus.TESTING_REBOOT: {
                return false;
            }
            case HostStatus.NORMAL: {
                if (messageCard !== undefined) {
                    messageCard.recoverToAutomatic = this.supervised && !globalSupervised;
                }
                this.supervised = globalSupervised;
                return true;
            }
            case HostStatus.DOWN: {
                const recurred = oldStatus === HostStatus.TESTING_REBOOT || oldStatus === HostStatus.WAITING_REBOOT;
                if (recurred) {
                    if (messageCard !== undefined) {
                        messageCard.dropToSupervised = !this.supervised && !globalSupervised;
                        messageCard.consolePreview = null;
                        await messageCard.post();
                    }
                    this.supervised = true;
                }
                const newCard = messageCards.addByHost(this, recurred);
                if (this.supervised || this.ipmiHost === null) {
                    return true;
                } else {
                    newCard.rebootRequested.value = true;
                    return await this.transition(HostStatus.WAITING_REBOOT);
                }
            }
            case HostStatus.WAITING_REBOOT: {
                try {
                    if (messageCard !== undefined) {
                        await messageCard.post();
                    }
                    await system(`ipmitool -I lanplus -H ${this.ipmiHost} -U elsabot -L OPERATOR -P ${this.ipmiPassword} power reset`);
                    await system(`ipmitool -I lanplus -H ${this.ipmiHost} -U elsabot -L OPERATOR -P ${this.ipmiPassword} power on`);
                    this.timeout = setTimeout(() => {
                        this.timeout = null;
                        this.transition(HostStatus.TESTING_REBOOT).catch(reason => console.error(reason));
                    }, pingConfig['reboot_wait'] * 1000);
                    return false;
                } catch (e) {
                    console.error(e);
                    if (messageCard !== undefined) {
                        messageCard.hasIpmiError.value = true;
                    }
                    return await this.transition(HostStatus.DOWN);
                }
            }
            default: {
                throw new Error(`Unallowed newStatus: ${newStatus}`);
            }
        }
    }
}

class MessageCard {
    constructor(host, recurred) {
        this.host = host;
        this.callbackId = uuidv4();
        this.messageTs = null;
        this.recurred = new TimedValue(recurred);

        this.status = new TimedValue(HostStatus.DOWN);
        this.rebootRequested = new TimedValue(false);
        this.rebootRequestedBy = null;
        this.hasIpmiError = new TimedValue(false);
        this.dropToSupervised = false;
        this.recoverToAutomatic = false;
        this.consolePreview = null;
    }

    get attachments() {
        let text = '';
        if (this.recurred.value) {
            text += 'This host is still unresponsive.';
        } else {
            text += `Not responding to ping for last ${pingConfig['loop_period'] * pingConfig['num_trials_before_down']} seconds.`;
        }
        text += ` (${this.recurred.timeFormatting})`;
        const actions = [];
        if (this.rebootRequested.value) {
            if (this.rebootRequestedBy !== null) {
                text += `\n:white_check_mark: <@${this.rebootRequestedBy}> knocks the door!`;
            } else {
                text += `\n:white_check_mark: Rebooting automatically...`;
            }
            text += ` (Sending IPMI reset command)`;
            text += ` (${this.rebootRequested.timeFormatting})`;
        } else if (this.status.value === HostStatus.DOWN && this.host.ipmiHost) {
            actions.push({
                'name': 'reset',
                'value': 'reset',
                'text': 'Force Reboot',
                'type': 'button'
            });
        }
        if (this.hasIpmiError.value) {
            text += '\n:x: An error occurred while issuing IPMI command.';
            text += ` (${this.hasIpmiError.timeFormatting})`;
        }
        if (this.status.value === HostStatus.WAITING_REBOOT || this.status.value === HostStatus.TESTING_REBOOT) {
            text += '\n:arrows_counterclockwise: Checking reachability...';
        }
        if (this.status.value === HostStatus.NORMAL) {
            text += `\n:white_check_mark: She's back!`;
            text += ` (${this.status.timeFormatting})`;
        }
        if (this.rebootRequested.value && this.status.value === HostStatus.DOWN) {
            text += `\n:x: Failed to reboot... sorry about that.`;
            text += ` (${this.status.timeFormatting})`;
        }
        if (this.dropToSupervised) {
            text += `\n:x: Dropping to supervised mode for this host.`
        }
        if (this.recoverToAutomatic) {
            text += `\n:white_check_mark: Recovering to automatic mode for this host.`;
        }
        const attachments = [{
            'color': '#2222aa',
            'title': `${this.host.hostId} is sleeping`,
            'text': text,
            'actions': actions,
            'callback_id': this.callbackId
        }];
        if (this.consolePreview !== null) {
            attachments.push({
                'text': 'Console Preview',
                'color': '#555555',
                'image_url': `${previewConfig['basepath']}preview/${this.callbackId}/${this.consolePreview.timeStamp.getTime()}/preview.png`,
                'ts': Math.floor(this.consolePreview.timeStamp.getTime()/1000)
            });
        }
        return {attachments: attachments};
    }

    post() {
        if (this.messageTs === null) {
            return web.chat.postMessage(channelId, '', this.attachments)
                .then(response => { this.messageTs = response.ts; return response; })
        } else {
            return web.chat.update(this.messageTs, channelId, '', this.attachments);
        }
    }
}

class MessageCards {
    constructor() {
        this.hostIdMap = {};
        this.callbackIdMap = {};
    }

    addByHost(host, recurred) {
        const oldCard = this.tryGetByHostId(host.hostId);
        if (oldCard !== undefined) {
            this.remove(oldCard);
        }
        const card = new MessageCard(host, recurred);
        this.hostIdMap[host.hostId] = card;
        this.callbackIdMap[card.callbackId] = card;
        return card;
    }

    remove(card) {
        delete this.hostIdMap[card.host.hostId];
        delete this.callbackIdMap[card.callbackId];
    }

    tryGetByCallbackId(callbackId) {
        return this.callbackIdMap[callbackId];
    }

    tryGetByHostId(hostId) {
        return this.hostIdMap[hostId];
    }
}

async function rebootRequested(callbackId, userId) {
    const card = messageCards.tryGetByCallbackId(callbackId);
    if (card === undefined) {
        return await web.chat.postEphemeral(channelId, 'Unknown callbackId\n(It seems that elsabot has suffered a restart. Sorry about that.)', userId);
    }
    card.rebootRequested.value = true;
    card.rebootRequestedBy = userId;
    await card.host.post(await card.host.transition(HostStatus.WAITING_REBOOT));
}

async function globalHeartbeat() {
    while (true) {
        const next = Date.now() + pingConfig['loop_period'] * 1000;
        try {
            promises = [];
            for (const host of hostList) {
                promises.push(host.heartbeat());
            }
            for (const promise of promises) {
                await promise;
            }
        } catch (e) {
            console.error(e);
        }
        const wait = next - Date.now();
        if (wait > 0) {
            setTimeout(() => globalHeartbeat().catch(reason => console.error(reason)), wait);
            break;
        }
    }
}

function system(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
}

async function consolePreviewUpdate(host) {
    const consolePreview = await preview(host.ipmiHost, 'elsabot', host.ipmiPassword);
    host.consolePreview = consolePreview;
    if (host.consolePreviewNeeded) {
        consolePreviewUpdate(host).catch(error => console.error(error));
    }
}

const config = JSON.parse(readFileSync('config.json', 'utf8'));
const slackConfig = config['slack'];
const channelId = slackConfig['channel'];
const globalSupervised = config['supervised'];
const pingConfig = config['ping'];
const previewConfig = config['preview'];

const messageCards = new MessageCards();
const hostList = [];
const web = new WebClient(slackConfig['token']);
const listener = createMessageAdapter(slackConfig['verification_token']);

for (const hostEntry of config['host']) {
    hostList.push(new Host(hostEntry['id'], hostEntry['ping_host'], hostEntry['ipmi_host'], hostEntry['ipmi_password']));
}

listener.action({}, payload => rebootRequested(payload.callback_id, payload.user.id).catch(reason => console.error(reason)));

listener.start(slackConfig['port']).then(() => {
    console.log(`Listening on ${slackConfig['port']}`);
});

globalHeartbeat().catch(reason => console.error(reason));

createServer((req, res) => {
    web.chat.postMessage(channelId, 'Hi, there! Elsabot is up and running!', {
        attachments: [
          {
            'color': '#2222aa',
            'title': 'The following hosts are covered:',
            'text': hostList.map(host => `• ${host.hostId} (ping ${host.pingHost}, IPMI ${host.ipmiHost})`).join('\n'),
            'mrkdwn': true
          },
          {
            'color': '#2222aa',
            'title': `The bot is running in ${globalSupervised ? 'supervised' : 'automatic'} mode`,
            'text': globalSupervised ? `I'll ask for confirmation before actually rebooting the host.` : `I'll try automatic reboot whenever I discover an unresponsive host.`
          }
        ]
    }).catch(reason => console.error(reason));
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Sending hello message...\n');
}).listen(config['management_port'], '127.0.0.1', () => console.log(`management port: ${config['management_port']}`));

const previewServer = new Koa();
previewServer.use(koaRoute.get('/preview/:callbackId/:timestamp/preview.png', (ctx, callbackId, timestamp) => {
    const card = messageCards.tryGetByCallbackId(callbackId);
    if (card === undefined) {
        ctx.status = 404;
        return;
    }
    if (card.consolePreview == null) {
        ctx.status = 404;
        return;
    }
    ctx.type = 'image/png';
    ctx.body = card.consolePreview.png;
}));
previewServer.listen(previewConfig['port']);

const rtm = new RtmClient(slackConfig['token']);
rtm.start();

exports.system = system;
