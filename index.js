const { WebClient } = require('@slack/client');
const EventsApi = require('@slack/events-api');
const uuidv4 = require('uuid/v4');

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
const verificationToken = process.env.SLACK_VERIFICATION_TOKEN;
const port = process.env.PORT;
const botState = new BotState();
const web = new WebClient(token);
const listener = new EventsApi.createSlackEventAdapter(verificationToken);

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

listener.on('message', event => 
    console.log(`Received a message event: user ${event.user} in channel ${event.channel} says ${event.text}`)
);

listener.on('error', console.error);

listener.start(port).then(() => {
    console.log(`Listening on ${port}`);
});