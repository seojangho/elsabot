const { WebClient } = require('@slack/client');
const { createMessageAdapter } = require('@slack/interactive-messages');
const uuidv4 = require('uuid/v4');
const { readFileSync } = require('fs');
const { exec } = require('child_process');

const HostStatus = {
    UNKNOWN: 0,
    TESTING_REBOOT: 1,
    NORMAL: 2,
    DOWN: 3,
    WAITING_REBOOT: 4
};

class Host {
    constructor(hostId, pingHost, ipmiHost, ipmiPassword) {
        this.hostId = hostId;
        this.pingHost = pingHost;
        this.ipmiHost = ipmiHost;
        this.ipmiPassword = ipmiPassword;

        this.supervised = globalSupervised;
        this.status = HostStatus.UNKNOWN;
        this.pingFailures = 0;
        this.timeout = null;
    }

    async heartbeat() {
        try {
            await system(`ping -c${pingConfig['count']} -w${pingConfig['deadline']} ${this.pingHost}`);
            this.pingFailures = 0;
            await this.transition(HostStatus.NORMAL);
        } catch (e) {
            if (this.status === HostStatus.WAITING_REBOOT) {
                return;
            }
            console.error(e);
            this.pingFailures++;
            if (this.pingFailures === pingConfig['num_trials_before_down']) {
                await this.transition(HostStatus.DOWN);
            }
        }
    }

    async transition(newStatus) {
        const oldStatus = this.status;
        if (oldStatus === newStatus) {
            return;
        }
        this.status = newStatus;
        this.pingFailures = 0;
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }
        const messageCard = messageCards.tryGetByHostId(this.hostId);
        if (messageCard !== undefined) {
            messageCard.status = newStatus;
        }
        switch (newStatus) {
            case HostStatus.TESTING_REBOOT: {
                break;
            }
            case HostStatus.NORMAL: {
                if (messageCard !== undefined) {
                    messageCard.recoverToAutomatic = this.supervised && !globalSupervised;
                    await messageCard.post();
                }
                this.supervised = globalSupervised;
                break;
            }
            case HostStatus.DOWN: {
                const recurred = oldStatus === HostStatus.TESTING_REBOOT || oldStatus === HostStatus.WAITING_REBOOT;
                if (recurred) {
                    if (messageCard !== undefined) {
                        messageCard.dropToSupervised = !this.supervised && !globalSupervised;
                        await messageCard.post();
                    }
                    this.supervised = true;
                }
                const newCard = messageCards.addByHost(this, recurred);
                if (this.supervised) {
                    await newCard.post();
                } else {
                    newCard.rebootRequested = true;
                    await this.transition(HostStatus.WAITING_REBOOT);
                }
                break;
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
                } catch (e) {
                    console.error(e);
                    if (messageCard !== undefined) {
                        messageCard.hasIpmiError = true;
                    }
                    await this.transition(HostStatus.DOWN);
                }
                break;
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
        this.recurred = recurred;

        this.status = HostStatus.DOWN;
        this.rebootRequested = false;
        this.rebootRequestedBy = null;
        this.hasIpmiError = false;
        this.dropToSupervised = false;
        this.recoverToAutomatic = false;
    }

    get attachments() {
        let text = '';
        if (this.recurred) {
            text += 'This host is still unresponsive.';
        } else {
            text += `Not responding to ping for last ${pingConfig['loop_period'] * pingConfig['num_trials_before_down']} seconds.`;
        }
        const actions = [];
        if (this.rebootRequested) {
            if (this.rebootRequestedBy !== null) {
                text += `\n:white_check_mark: <@${this.rebootRequestedBy}> knocks the door!`;
            } else {
                text += `\n:white_check_mark: Rebooting automatically...`;
            }
        } else if (this.status === HostStatus.DOWN) {
            actions.push({
                'name': 'reset',
                'value': 'reset',
                'text': 'Force Reboot',
                'type': 'button'
            });
        }
        if (this.hasIpmiError) {
            text += '\n:x: An error occurred while issuing IPMI command.';
        }
        if (this.status === HostStatus.NORMAL) {
            text += `\n:white_check_mark: She's back!`;
        }
        if (this.rebootRequested && this.status === HostStatus.DOWN) {
            text += `\n:x: Failed to reboot... sorry about that.`;
        }
        if (this.dropToSupervised) {
            text += `\n:x: Dropping to supervised mode for this host.`
        }
        if (this.recoverToAutomatic) {
            text += `\n:white_check_mark: Recovering to automatic mode for this host.`;
        }
        return {
            attachments: [
              {
                'color': '#2222aa',
                'title': `${this.host.hostId} is sleeping`,
                'text': text,
                'actions': actions,
                'callback_id': this.callbackId
              }
            ]
          }
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
    card.rebootRequested = true;
    card.rebootRequestedBy = userId;
    await card.host.transition(HostStatus.WAITING_REBOOT);
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
        exec(commandPrefix + command, (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
}

const config = JSON.parse(readFileSync('config.json', 'utf8'));
const slackConfig = config['slack'];
const channelId = slackConfig['channel'];
const globalSupervised = config['supervised'];
const pingConfig = config['ping'];
const commandPrefix = config['command_prefix'];

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

if (process.env.ELSABOT_STARTUP_MESSAGE) {
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
}
