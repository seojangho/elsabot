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
    }

    async heartbeat() {
        console.log(`${this.hostId} beats!`);
        if (this.status === HostStatus.WAITING_REBOOT) {
            return;
        }
        try {
            await system(`ping -c${pingConfig['count']} -w${pingConfig['deadline']} ${this.pingHost}`);
            this.pingFailures = 0;
            await this.transition(HostStatus.NORMAL);
        } catch (e) {
            this.pingFailures++;
            if (this.pingFailures === pingConfig['num_trials_before_down']) {
                await this.transition(HostStatus.DOWN);
            }
        }
    }

    async transition(newStatus) {
        const oldStatus = this.status;
        console.log(`${this.hostId} ${this.oldStatus} -> ${this.newStatus}`);
        if (oldStatus === newStatus) {
            return;
        }
        this.status = newStatus;
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
                if (oldStatus === HostStatus.TESTING_REBOOT) {
                    if (messageCard !== undefined) {
                        messageCard.dropToSupervised = !this.supervised && !globalSupervised;
                        await messageCard.post();
                    }
                    this.supervised = true;
                }
                const newCard = messageCards.addByHost(this);
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
                    console.log(await system(`ipmitool -I lanplus -H ${this.ipmiHost} -U elsabot -L OPERATOR -P ${this.ipmiPassword} power status`));
                } catch (e) {
                    console.error(e);
                    if (messageCard !== undefined) {
                        messageCard.hasIpmiError = true;
                    }
                }
                setTimeout(() => this.transition(HostStatus.TESTING_REBOOT), pingConfig['reboot_wait'] * 1000);
                if (messageCard !== undefined) {
                    await messageCard.post();
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
    constructor(host) {
        this.host = host;
        this.callbackId = uuidv4();
        this.messageTs = null;

        this.status = HostStatus.DOWN;
        this.rebootRequested = false;
        this.rebootRequestedBy = null;
        this.hasIpmiError = false;
        this.dropToSupervised = false;
        this.recoverToAutomatic = false;
    }

    get attachments() {
        let text = `Not responding to ping for last ${pingConfig['loop_interval'] * pingConfig['num_trials_before_down']} seconds.`;
        const actions = [];
        if (this.rebootRequested) {
            if (this.rebootRequestedBy !== null) {
                text += `\n:white_check_mark: <@${userId}> knocks the door!`;
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
        if (this.status === HostStatus.NORMAL) {
            text += `\n:white_check_mark: She's back!`;
        }
        if (this.hasIpmiError) {
            text += '\n:x: An error occurred while issuing IPMI command.';
        }
        if (this.rebootRequested && this.status === HostStatus.DOWN) {
            text += `\n:x: She's not coming back... sorry about that.`;
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
                'color': '#aaaaaa',
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

    addByHost(host) {
        const card = new MessageCard(host);
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
    promises = [];
    for (const host of hostList) {
        promises.push(host.heartbeat());
    }
    for (const promise of promises) {
        await promise;
    }
    setTimeout(() => globalHeartbeat().catch(reason => console.error(reason)), pingConfig['loop_interval'] * 1000);
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