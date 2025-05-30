const AWS = require("aws-sdk");

// Configure the S3 bucket and key prefix for stored raw emails, and the
// mapping of email addresses to forward from and to.
//
// Expected keys/values:
//
// - fromEmail: Forwarded emails will come from this verified address
//
// - subjectPrefix: Forwarded emails subject will contain this prefix
//
// - emailBucket: S3 bucket name where SES stores emails.
//
// - emailKeyPrefix: S3 key name prefix where SES stores email. Include the
//   trailing slash.
//
// - allowPlusSign: Enables support for plus sign suffixes on email addresses.
//   If set to `true`, the username/mailbox part of an email address is parsed
//   to remove anything after a plus sign. For example, an email sent to
//   `example+test@example.com` would be treated as if it was sent to
//   `example@example.com`.
//
// - forwardMapping: Object where the key is the lowercase email address from
//   which to forward and the value is an array of email addresses to which to
//   send the message.
//
//   To match all email addresses on a domain, use a key without the name part
//   of an email address before the "at" symbol (i.e. `@example.com`).
//
//   To match a mailbox name on all domains, use a key without the "at" symbol
//   and domain part of an email address (i.e. `info`).
//
//   To match all email addresses matching no other mapping, use "@" as a key.
const defaultConfig = {
    fromEmail: process.env.MAIL_SENDER,
    subjectPrefix: "",
    emailBucket: process.env.MAIL_S3_BUCKET,
    emailKeyPrefix: process.env.MAIL_S3_PREFIX,
    allowPlusSign: true,
    forwardMapping: {
        "@": process.env.MAIL_RECIPIENTS.split(","),
    },
};

/**
 * Parses the SES event record provided for the `mail` and `receipients` data.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.parseEvent = (data) => {
    // Validate characteristics of a SES event record.
    if (
        !data.event ||
        !Object.hasOwn(data.event, "Records") ||
        data.event.Records.length !== 1 ||
        !Object.hasOwn(data.event.Records[0], "eventSource") ||
        data.event.Records[0].eventSource !== "aws:ses" ||
        data.event.Records[0].eventVersion !== "1.0"
    ) {
        data.log({
            message: "parseEvent() received invalid SES message:",
            level: "error",
            event: JSON.stringify(data.event),
        });
        return Promise.reject(new Error("Error: Received invalid SES message."));
    }

    data.email = data.event.Records[0].ses.mail;
    data.recipients = data.event.Records[0].ses.receipt.recipients;
    return Promise.resolve(data);
};

/**
 * Transforms the original recipients to the desired forwarded destinations.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.transformRecipients = (data) => {
    let newRecipients = [];
    data.originalRecipients = data.recipients;
    data.recipients.forEach((origEmail) => {
        let origEmailKey = origEmail.toLowerCase();
        if (data.config.allowPlusSign) {
            origEmailKey = origEmailKey.replace(/\+.*?@/, "@");
        }
        if (Object.hasOwn(data.config.forwardMapping, origEmailKey)) {
            newRecipients = newRecipients.concat(data.config.forwardMapping[origEmailKey]);
            data.originalRecipient = origEmail;
        } else {
            let origEmailDomain;
            let origEmailUser;
            const pos = origEmailKey.lastIndexOf("@");
            if (pos === -1) {
                origEmailUser = origEmailKey;
            } else {
                origEmailDomain = origEmailKey.slice(pos);
                origEmailUser = origEmailKey.slice(0, pos);
            }
            if (origEmailDomain && Object.hasOwn(data.config.forwardMapping, origEmailDomain)) {
                newRecipients = newRecipients.concat(data.config.forwardMapping[origEmailDomain]);
                data.originalRecipient = origEmail;
            } else if (origEmailUser && Object.hasOwn(data.config.forwardMapping, origEmailUser)) {
                newRecipients = newRecipients.concat(data.config.forwardMapping[origEmailUser]);
                data.originalRecipient = origEmail;
            } else if (Object.hasOwn(data.config.forwardMapping, "@")) {
                newRecipients = newRecipients.concat(data.config.forwardMapping["@"]);
                data.originalRecipient = origEmail;
            }
        }
    });

    if (!newRecipients.length) {
        data.log({
            message: `Finishing process. No new recipients found for original destinations: ${data.originalRecipients.join(
                ", ",
            )}`,
            level: "info",
        });
        return data.callback();
    }

    data.recipients = newRecipients;
    return Promise.resolve(data);
};

/**
 * Fetches the message data from S3.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.fetchMessage = (data) => {
    // Copying email object to ensure read permission
    data.log({
        level: "info",
        message: `Fetching email at s3://${data.config.emailBucket}/${data.config.emailKeyPrefix}${data.email.messageId}`,
    });
    return new Promise((resolve, reject) => {
        data.s3.copyObject(
            {
                Bucket: data.config.emailBucket,
                CopySource: `${data.config.emailBucket}/${data.config.emailKeyPrefix}${data.email.messageId}`,
                Key: data.config.emailKeyPrefix + data.email.messageId,
                ACL: "private",
                ContentType: "text/plain",
                StorageClass: "STANDARD",
            },
            (err) => {
                if (err) {
                    data.log({
                        level: "error",
                        message: "copyObject() returned error:",
                        error: err,
                        stack: err.stack,
                    });
                    return reject(new Error("Error: Could not make readable copy of email."));
                }

                // Load the raw email from S3
                data.s3.getObject(
                    {
                        Bucket: data.config.emailBucket,
                        Key: data.config.emailKeyPrefix + data.email.messageId,
                    },
                    (err, result) => {
                        if (err) {
                            data.log({
                                level: "error",
                                message: "getObject() returned error:",
                                error: err,
                                stack: err.stack,
                            });
                            return reject(new Error("Error: Failed to load message body from S3."));
                        }
                        data.emailData = result.Body.toString();
                        return resolve(data);
                    },
                );
            },
        );
    });
};

/**
 * Processes the message data, making updates to recipients and other headers
 * before forwarding message.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.processMessage = (data) => {
    let match = data.emailData.match(/^((?:.+\r?\n)*)(\r?\n(?:.*\s+)*)/m);
    let header = match?.[1] ? match[1] : data.emailData;
    const body = match?.[2] ? match[2] : "";

    // Add "Reply-To:" with the "From" address if it doesn't already exists
    if (!/^reply-to:[\t ]?/im.test(header)) {
        match = header.match(/^from:[\t ]?(.*(?:\r?\n\s+.*)*\r?\n)/im);
        const from = match?.[1] ? match[1] : "";
        if (from) {
            header = `${header}Reply-To: ${from}`;
            data.log({
                level: "info",
                message: `Added Reply-To address of: ${from}`,
            });
        } else {
            data.log({
                level: "info",
                message: "Reply-To address not added because From address was not " + "properly extracted.",
            });
        }
    }

    // SES does not allow sending messages from an unverified address,
    // so replace the message's "From:" header with the original
    // recipient (which is a verified domain)
    header = header.replace(/^from:[\t ]?(.*(?:\r?\n\s+.*)*)/gim, (_match, from) => {
        let fromText;
        if (data.config.fromEmail) {
            fromText = `From: ${from.replace(/<(.*)>/, "").trim()} <${data.config.fromEmail}>`;
        } else {
            fromText = `From: ${from.replace("<", "at ").replace(">", "")} <${data.originalRecipient}>`;
        }
        return fromText;
    });

    // Add a prefix to the Subject
    if (data.config.subjectPrefix) {
        header = header.replace(
            /^subject:[\t ]?(.*)/gim,
            (_match, subject) => `Subject: ${data.config.subjectPrefix}${subject}`,
        );
    }

    // Replace original 'To' header with a manually defined one
    if (data.config.toEmail) {
        header = header.replace(/^to:[\t ]?(.*)/gim, () => `To: ${data.config.toEmail}`);
    }

    // Remove the Return-Path header.
    header = header.replace(/^return-path:[\t ]?(.*)\r?\n/gim, "");

    // Remove Sender header.
    header = header.replace(/^sender:[\t ]?(.*)\r?\n/gim, "");

    // Remove Message-ID header.
    header = header.replace(/^message-id:[\t ]?(.*)\r?\n/gim, "");

    // Remove all DKIM-Signature headers to prevent triggering an
    // "InvalidParameterValue: Duplicate header 'DKIM-Signature'" error.
    // These signatures will likely be invalid anyways, since the From
    // header was modified.
    header = header.replace(/^dkim-signature:[\t ]?.*\r?\n(\s+.*\r?\n)*/gim, "");

    data.emailData = header + body;
    return Promise.resolve(data);
};

/**
 * Send email using the SES sendRawEmail command.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.sendMessage = (data) => {
    const params = {
        Destinations: data.recipients,
        Source: data.originalRecipient,
        RawMessage: {
            Data: data.emailData,
        },
    };
    data.log({
        level: "info",
        message: `sendMessage: Sending email via SES. Original recipients: ${data.originalRecipients.join(
            ", ",
        )}. Transformed recipients: ${data.recipients.join(", ")}.`,
    });
    return new Promise((resolve, reject) => {
        data.ses.sendRawEmail(params, (err, result) => {
            if (err) {
                data.log({
                    level: "error",
                    message: "sendRawEmail() returned error.",
                    error: err,
                    stack: err.stack,
                });
                return reject(new Error("Error: Email sending failed."));
            }
            data.log({
                level: "info",
                message: "sendRawEmail() successful.",
                result: result,
            });
            resolve(data);
        });
    });
};

/**
 * Handler function to be invoked by AWS Lambda with an inbound SES email as
 * the event.
 *
 * @param {object} event - Lambda event from inbound email received by AWS SES.
 * @param {object} context - Lambda context object.
 * @param {object} callback - Lambda callback object.
 * @param {object} overrides - Overrides for the default data, including the
 * configuration, SES object, and S3 object.
 */
exports.handler = (event, context, callback, overrides) => {
    const steps = overrides?.steps
        ? overrides.steps
        : [
              exports.parseEvent,
              exports.transformRecipients,
              exports.fetchMessage,
              exports.processMessage,
              exports.sendMessage,
          ];
    const data = {
        event: event,
        callback: callback,
        context: context,
        config: overrides?.config ? overrides.config : defaultConfig,
        log: overrides?.log ? overrides.log : console.log,
        ses: overrides?.ses ? overrides.ses : new AWS.SES(),
        s3: overrides?.s3 ? overrides.s3 : new AWS.S3({ signatureVersion: "v4" }),
    };
    Promise.series(steps, data)
        .then((data) => {
            data.log({
                level: "info",
                message: "Process finished successfully.",
            });
            return data.callback();
        })
        .catch((err) => {
            data.log({
                level: "error",
                message: `Step returned error: ${err.message}`,
                error: err,
                stack: err.stack,
            });
            return data.callback(new Error("Error: Step returned error."));
        });
};

Promise.series = (promises, initValue) =>
    promises.reduce((chain, promise) => {
        if (typeof promise !== "function") {
            return chain.then(() => {
                throw new Error(`Error: Invalid promise item: ${promise}`);
            });
        }
        return chain.then(promise);
    }, Promise.resolve(initValue));
