/**
 * The MIT License (MIT)
 * Copyright (c) 2016 GochoMugo <mugo@forfuture.co.ke>
 *
 * The client with the fancy boobs and ass!
 *
 * Notes:
 * -----
 * 1. Use of queue to send messages was first proposed at
 *    https://github.com/yagop/node-telegram-bot-api/issues/192#issuecomment-249488807
 * 2. Kick-without-Ban was suggested to me by @kamikazechaser
 */


// npm-installed modules
const _ = require("lodash");
const Debug = require("debug");
const Promise = require("bluebird");
const TelegramBot = require("node-telegram-bot-api");
const tgresolve = require("tg-resolve");


// module variables
const debug = Debug("tgfancy:client");
// Maximum length of a Message's text
const MAX_MSG_TXT_LEN = 4096;
// WARNING: these functions MUST accept 'chatId' as their first argument
const resolveChatIdFns = ["sendMessage", "forwardMessage",
    "sendPhoto", "sendAudio", "sendDocument", "sendSticker",
    "sendVideo", "sendVoice", "sendLocation", "sendVenue",
    "sendGame", "sendChatAction", "kickChatMember",
    "unbanChatMember", "getChat", "getChatAdministrators",
    "getChatMembersCount", "getChatMember", "leaveChat"];
// WARNING: these functions MUST accept 'chatId' as their first argument
const queuedSendFns = ["sendMessage", "sendPhoto", "sendAudio",
    "sendDocument", "sendSticker", "sendVideo", "sendVoice",
    "sendLocation", "sendVenue", "sendGame"];


exports = module.exports = class Tgfancy {
    /**
     * Construct a new client.
     * 'token' and 'options' are passed to TelegramBot.
     *
     * @constructor
     * @param  {String} token
     * @param  {Options} [options]
     * @param  {Function} [options.resolveChatId]
     */
    constructor(token, options) {
        const self = this;
        this.token = token;
        this.options = _.defaultsDeep({}, options, {
            resolveChatId: tgresolve,
        });
        this._telegram = new TelegramBot(token, options);

        // Multiple internal queues are used to ensure *this* client
        // sends the messages, to a specific chat, in order
        this._sendQueues = {};
        this._sending = {};

        // some patching to ensure stuff works out of the box ;-)
        this._sendQueueTrigger = this._sendQueueTrigger.bind(this);
        this.kickChatMember = this.kickChatMember.bind(this);

        // By default, all the public methods of TelegramBot should be
        // made available on Tgfancy.
        // We allow Tgfancy to override any of the functions.
        Object.getOwnPropertyNames(TelegramBot.prototype).forEach(function(methodName) {
            const method = self._telegram[methodName];
            if (typeof method !== "function" || self[methodName]) return;
            self[methodName] = method.bind(self._telegram);
        });

        // The TelegramBot#sendMessage() performs paging of
        // the text across 4096th-char boundaries
        this.sendMessage = this._pageText(this.sendMessage);

        // Some functions are wrapped around to provide queueing of
        // multiple messages in a bid to ensure order
        queuedSendFns.forEach(function(methodName) {
            self[methodName] = self._sendQueueWrap(self[methodName]);
        });

        // Some functions are wrapped around to resolve usernames
        // to valid chat IDs. We need to resolve the chat ID
        // BEFORE queueing the function, so that the method uses
        // the same internal send-queue, through the resolved
        // chat ID.
        resolveChatIdFns.forEach(function(methodName) {
            self[methodName] = self._resolveChatId(self[methodName]);
        });
    }

    /**
     * Return a function wrapping around the supplied 'method' that
     * uses queueing to send the message.
     *
     * @param  {Function} method Context-bound function
     * @return {Function} The function maintains the same signature as 'method'
     */
    _sendQueueWrap(method) {
        const self = this;

        return function(...args) {
            let resolve, reject;
            const promise = new Promise(function(promiseResolve, promiseReject) {
                resolve = promiseResolve;
                reject = promiseReject;
            });
            const chatId = args[0];
            let queue = self._sendQueues[chatId];

            if (!queue) {
                queue = self._sendQueues[chatId] = [];
            }

            debug("queueing message to chat %s", chatId);
            queue.push({ method, args, resolve, reject });
            process.nextTick(function() {
               return self._sendQueueTrigger(chatId);
            });
            return promise;
        };
    }

    /**
     * Trigger processing of the send-queue for a particular chat.
     * This is invoked internally to handle queue processing.
     *
     * @param  {String} chatId
     */
    _sendQueueTrigger(chatId) {
        const self = this;
        const queue = this._sendQueues[chatId];
        const sending = this._sending[chatId];

        // if we are already processing the queue, or
        // there is no queue, bolt!
        if (sending || !queue) return;

        this._sending[chatId] = true;
        delete this._sendQueues[chatId];

        debug("processing %d requests in send-queue for chat %s", queue.length, chatId);
        Promise.mapSeries(queue, function(request) {
            return request.method(...request.args)
                .then(request.resolve)
                .catch(request.reject);
        }).then(function() {
            debug("processing queue complete");
            delete self._sending[chatId];
            // trigger queue processing, as more requests might have been
            // queued up while we were busy above
            self._sendQueueTrigger(chatId);
        });
    }

    /**
     * Return a function that wraps around 'sendMessage', to
     * add paging fanciness.
     *
     * @param  {Function} sendMessage
     * @return {Function} sendMessage(chatId, message, form)
     */
    _pageText(sendMessage) {
        return function(chatId, message, form={}) {
            if (message.length < MAX_MSG_TXT_LEN) {
                return sendMessage(chatId, message, form);
            }

            let index = 0;
            let parts = [];
            // we are reserving 8 characters for adding the page number in
            // the following format: [01/10]
            let reserveSpace = 8;
            let shortTextLength = MAX_MSG_TXT_LEN - reserveSpace;
            let shortText;

            while (shortText = message.substr(index, shortTextLength)) {
                parts.push(shortText);
                index += shortTextLength;
            }

            // The reserve space limits us to accommodate for not more
            // than 99 pages. We signal an error to the user.
            if (parts.length > 99) {
                debug("Tgfancy#sendMessage: Paging resulted into more than 99 pages");
                return new Promise(function(resolve, reject) {
                    const error = new Error("Paging resulted into more than the maximum number of parts allowed");
                    error.parts = parts;
                    return reject(error);
                });
            }

            parts = parts.map(function(part, i) {
                return `[${i+1}/${parts.length}] ${part}`;
            });

            debug("sending message in %d pages", parts.length);
            return Promise.mapSeries(parts, function(part) {
                return sendMessage(chatId, part, form);
            });
        };
    }

    /**
     * Return a function wrapping around 'method' that resolves
     * usernames to valid chat IDs.
     *
     * @param  {Function} method
     * @return {Function} wrapped 'method'
     */
    _resolveChatId(method) {
        const self = this;

        return function(chatId, ...args) {
            if (typeof chatId === "number" ||
                chatId[0] !== "@")
                return method(chatId, ...args);

            return new Promise(function(resolve, reject) {
                debug("resolving '%s' to chat ID", chatId);
                return self.options.resolveChatId(self.token, chatId, function(error, data) {
                    if (error) return reject(error);
                    return method(data.id, ...args)
                        .then(resolve).catch(reject);
                });
            });
        };
    }

    /**
     * Kick chat member.
     *
     * @param  {String|Number} chatId
     * @param  {String|Number} userId
     * @param  {Boolean} [ban=true]
     * @return {Promise}
     */
    kickChatMember(chatId, userId, ban=true) {
        const self = this;

        if (ban) {
            debug("kicking and banning user '%s' in chat %s", userId, chatId);
            return this._telegram.kickChatMember(chatId, userId);
        }

        return new Promise(function(resolve, reject) {
            debug("kicking user '%s' in chat %s", userId, chatId);
            return self._telegram.kickChatMember(chatId, userId)
                .then(function(kickResponse) {
                    debug("unbanning user '%s' in chat %s", userId, chatId);
                    return self._telegram.unbanChatMember(chatId, userId)
                        .then(function(unbanResponse) {
                            return resolve([kickResponse, unbanResponse]);
                        }).catch(reject);
                })
                .catch(reject);
        });
    }
};