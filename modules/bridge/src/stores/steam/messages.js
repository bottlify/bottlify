/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The messages this client exchanges with a Steam connection manager (CM):
 * their numbers (EMsg) and the fields of each that it reads or writes, as
 * Valve's .proto definitions give them. A field not listed is not used.
 */

/** @typedef {import('../../../../core/src/steam/protobuf.js').Schema} Schema */

export const EMsg = Object.freeze({
    Multi: 1,
    DestJobFailed: 113,
    ServiceMethodResponse: 147,
    ServiceMethodCallFromClient: 151,
    ClientHeartBeat: 703,
    ClientLogOff: 706,
    ClientLogOnResponse: 751,
    ClientLoggedOff: 757,
    ClientLicenseList: 780,
    ClientLogon: 5514,
    ClientPICSProductInfoRequest: 8903,
    ClientPICSProductInfoResponse: 8904,
    ClientPICSAccessTokenRequest: 8905,
    ClientPICSAccessTokenResponse: 8906,
    ServiceMethodCallFromClientNonAuthed: 9804,
    ClientHello: 9805,
});

/** The results a client acts on (Steam's EResult). */
export const EResult = Object.freeze({
    OK: 1,
    Fail: 2,
    InvalidPassword: 5,
    FileNotFound: 9,
    Busy: 10,
    AccessDenied: 15,
    ServiceUnavailable: 20,
    Expired: 27,
    TryAnotherCM: 48,
});

/** The protocol version the client announces in its hello and logon. */
export const PROTOCOL_VERSION = 65580;

/** A protobuf message's EMsg has its top bit set. */
export const PROTO_MASK = 0x80000000;

/** @type {Schema} */
export const ProtoBufHeader = {
    steamid: [1, 'fixed64'],
    client_sessionid: [2, 'int32'],
    jobid_source: [10, 'fixed64'],
    jobid_target: [11, 'fixed64'],
    target_job_name: [12, 'string'],
    eresult: [13, 'int32'],
    error_message: [14, 'string'],
    realm: [32, 'uint32'],
};

/** @type {Schema} */
export const Multi = { size_unzipped: [1, 'uint32'], message_body: [2, 'bytes'] };

/** @type {Schema} */
export const ClientHello = { protocol_version: [1, 'uint32'] };

/** @type {Schema} */
export const ClientHeartBeat = { send_reply: [1, 'bool'] };

/** @type {Schema} */
const IPAddress = { v4: [1, 'fixed32'] };

/** @type {Schema} */
export const ClientLogon = {
    protocol_version: [1, 'uint32'],
    cell_id: [3, 'uint32'],
    client_package_version: [5, 'uint32'],
    client_language: [6, 'string'],
    client_os_type: [7, 'uint32'],
    should_remember_password: [8, 'bool'],
    obfuscated_private_ip: [11, IPAddress],
    machine_id: [30, 'bytes'],
    account_name: [50, 'string'],
    machine_name: [96, 'string'],
    supports_rate_limit_response: [102, 'bool'],
    access_token: [108, 'string'],
};

/** @type {Schema} */
export const ClientLogonResponse = {
    eresult: [1, 'int32'],
    heartbeat_seconds: [3, 'int32'],
    cell_id: [7, 'uint32'],
    eresult_extended: [10, 'int32'],
    user_country: [16, 'string'],
    client_instance_id: [27, 'uint64'],
};

/** @type {Schema} */
export const ClientLoggedOff = { eresult: [1, 'int32'] };

/** @type {Schema} */
export const ClientLicenseList = {
    eresult: [1, 'int32'],
    licenses: [2, {
        package_id: [1, 'uint32'],
        time_created: [2, 'fixed32'],
        flags: [7, 'uint32'],
        license_type: [9, 'uint32'],
        access_token: [17, 'uint64'],
    }, 'repeated'],
};

/** @type {Schema} */
export const PICSAccessTokenRequest = {
    packageids: [1, 'uint32', 'repeated'],
    appids: [2, 'uint32', 'repeated'],
};

/** @type {Schema} */
export const PICSAccessTokenResponse = {
    package_access_tokens: [1,
        { packageid: [1, 'uint32'], access_token: [2, 'uint64'] }, 'repeated'],
    app_access_tokens: [3, { appid: [1, 'uint32'], access_token: [2, 'uint64'] }, 'repeated'],
};

/** @type {Schema} */
export const PICSProductInfoRequest = {
    packages: [1, { packageid: [1, 'uint32'], access_token: [2, 'uint64'] }, 'repeated'],
    apps: [2, { appid: [1, 'uint32'], access_token: [2, 'uint64'] }, 'repeated'],
    meta_data_only: [3, 'bool'],
    single_response: [7, 'bool'],
};

/** @type {Schema} */
export const PICSProductInfoResponse = {
    apps: [1, {
        appid: [1, 'uint32'], change_number: [2, 'uint32'], missing_token: [3, 'bool'],
        buffer: [5, 'bytes'],
    }, 'repeated'],
    unknown_appids: [2, 'uint32', 'repeated'],
    packages: [3, {
        packageid: [1, 'uint32'], change_number: [2, 'uint32'], missing_token: [3, 'bool'],
        buffer: [5, 'bytes'],
    }, 'repeated'],
    unknown_packageids: [4, 'uint32', 'repeated'],
    response_pending: [6, 'bool'],
};

/** The Authentication service's messages, called as unified service methods. */
export const Authentication = Object.freeze({
    /** @type {Schema} */
    BeginAuthSessionViaQRRequest: {
        device_friendly_name: [1, 'string'],
        platform_type: [2, 'int32'],
        device_details: [3, {
            device_friendly_name: [1, 'string'],
            platform_type: [2, 'int32'],
            os_type: [3, 'int32'],
            gaming_device_type: [4, 'uint32'],
        }],
        website_id: [4, 'string'],
    },
    /** @type {Schema} */
    BeginAuthSessionViaQRResponse: {
        client_id: [1, 'uint64'],
        challenge_url: [2, 'string'],
        request_id: [3, 'bytes'],
        interval: [4, 'float'],
        allowed_confirmations: [5, { confirmation_type: [1, 'int32'] }, 'repeated'],
    },
    /** @type {Schema} */
    PollAuthSessionStatusRequest: {
        client_id: [1, 'uint64'],
        request_id: [2, 'bytes'],
    },
    /** @type {Schema} */
    PollAuthSessionStatusResponse: {
        new_client_id: [1, 'uint64'],
        new_challenge_url: [2, 'string'],
        refresh_token: [3, 'string'],
        access_token: [4, 'string'],
        had_remote_interaction: [5, 'bool'],
        account_name: [6, 'string'],
    },
});

/** EAuthTokenPlatformType: a token the client logs on with is a SteamClient one. */
export const PLATFORM_STEAM_CLIENT = 1;

/** EOSType of Windows 10, what the client says it runs on. */
export const OS_WINDOWS_10 = 16;

/** The gaming device type of a PC, as a desktop client gives it. */
export const GAMING_DEVICE_PC = 1;

/** The realm of the global Steam universe, as a call outside a session names it. */
export const REALM_GLOBAL = 1;
