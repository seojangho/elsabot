const { WebClient } = require('@slack/client');
const { createMessageAdapter } = require('@slack/interactive-messages');
const uuidv4 = require('uuid/v4');
const { readFileSync } = require('fs');
const { exec } = require('child_process');

const ElsaStatus = {
    UNKNOWN: 0,
    TESTING_REBOOT: 1,
    NORMAL: 2,
    DOWN: 3,
    WAITING_REBOOT: 4
};

class Elsa {
    constructor(elsaId, pingHost, ipmiHost, ipmiPassword) {
        this.elsaId = elsaId;
        this.pingHost = pingHost;
        this.ipmiHost = ipmiHost;
        this.ipmiPassword = ipmiPassword;

        this.supervised = globalSupervised;
        this.status = ElsaStatus.UNKNOWN;
        this.pingFailures = 0;
    }

    async heartbeat() {
        if (this.status === ElsaStatus.WAITING_REBOOT) {
            return;
        }
        try {
            await system(`ping -c${pingConfig['count']} -w${pingConfig['deadline']} ${this.pingHost}`);
            this.pingFailures = 0;
            await this.transition(ElsaStatus.NORMAL);
        } catch (e) {
            this.pingFailures++;
            if (this.pingFailures === pingConfig['num_trials_before_down']) {
                await this.transition(ElsaStatus.DOWN);
            }
        }
    }

    async transition(newStatus) {
        const oldStatus = this.status;
        if (oldStatus === newStatus) {
            return;
        }
        this.status = newStatus;
        const messageCard = messageCards.tryGetByElsaId(this.elsaId);
        if (messageCard !== undefined) {
            messageCard.status = newStatus;
        }
        switch (newStatus) {
            case ElsaStatus.TESTING_REBOOT: {
                break;
            }
            case ElsaStatus.NORMAL: {
                if (messageCard !== undefined) {
                    messageCard.recoverToAutomatic = this.supervised && !globalSupervised;
                    await messageCard.post();
                }
                this.supervised = globalSupervised;
                break;
            }
            case ElsaStatus.DOWN: {
                if (oldStatus === ElsaStatus.TESTING_REBOOT) {
                    if (messageCard !== undefined) {
                        messageCard.dropToSupervised = !this.supervised && !globalSupervised;
                        await messageCard.post();
                    }
                    this.supervised = true;
                }
                const newCard = messageCards.addByElsa(this);
                if (this.supervised) {
                    await newCard.post();
                } else {
                    newCard.rebootRequested = true;
                    await this.transition(ElsaStatus.WAITING_REBOOT);
                }
                break;
            }
            case ElsaStatus.WAITING_REBOOT: {
                console.log(await system(`ipmitool -I lanplus -H ${this.ipmiHost} -U elsabot -L OPERATOR -P ${this.ipmiPassword} power status`));
                setTimeout(() => this.transition(ElsaStatus.TESTING_REBOOT), pingConfig['reboot_wait'] * 1000);
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
    constructor(elsa) {
        this.elsa = elsa;
        this.callbackId = uuidv4();
        this.messageTs = null;

        this.status = ElsaStatus.DOWN;
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
        } else if (this.status === ElsaStatus.DOWN) {
            actions.push({
                'name': 'reset',
                'value': 'reset',
                'text': 'Force Reboot',
                'type': 'button'
            });
        }
        if (this.status === ElsaStatus.NORMAL) {
            text += `\n:white_check_mark: She's back!`;
        }
        if (this.hasIpmiError) {
            text += '\n:x: An error occurred while issuing IPMI command.';
        }
        if (this.rebootRequested && this.status === ElsaStatus.DOWN) {
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
                'title': `${this.elsa.elsaId} is sleeping`,
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
        this.elsaIdMap = {};
        this.callbackIdMap = {};
    }

    addByElsa(elsa) {
        const card = new MessageCard(elsa);
        this.elsaIdMap[elsa.elsaId] = card;
        this.callbackIdMap[card.callbackId] = card;
        return card;
    }

    remove(card) {
        delete this.elsaIdMap[card.elsa.elsaId];
        delete this.callbackIdMap[card.callbackId];
    }

    tryGetByCallbackId(callbackId) {
        return this.callbackIdMap[callbackId];
    }

    tryGetByElsaId(elsaId) {
        return this.elsaIdMap[elsaId];
    }
}

async function rebootRequested(callbackId, userId) {
    const card = messageCards.tryGetByCallbackId(callbackId);
    if (card === undefined) {
        return await web.chat.postEphemeral(channelId, 'Unknown callbackId\n(It seems that elsabot has suffered a restart. Sorry about that.)', userId);
    }
    card.rebootRequested = true;
    card.rebootRequestedBy = userId;
    try {
        await card.elsa.transition(ElsaStatus.WAITING_REBOOT);
    } catch (e) {
        console.error(e);
        card.hasIpmiError = true;
        await card.post();
    }
}

async function globalHeartbeat() {
    promises = [];
    for (const elsa of elsaList) {
        promises.push(elsa.heartbeat());
    }
    for (const promise of promises) {
        await promise;
    }
    setTimeout(globalHeartbeat, pingConfig['loop_interval'] * 1000);
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
const elsaList = [];
const web = new WebClient(slackConfig['token']);
const listener = createMessageAdapter(slackConfig['verification_token']);

for (const elsaEntry of config['elsa']) {
    elsaList.push(new Elsa(elsaEntry['id'], elsaEntry['ping_host'], elsaEntry['ipmi_host'], elsaEntry['ipmi_password']));
}

listener.action({}, payload => rebootRequested(payload.callback_id, payload.user.id));

listener.start(slackConfig['port']).then(() => {
    console.log(`Listening on ${slackConfig['port']}`);
});

globalHeartbeat();