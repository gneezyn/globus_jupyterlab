import {PromiseDelegate} from '@phosphor/coreutils';
import CryptoJS = require('crypto-js');
import {queryParams} from "./utils";

const CLIENT_ID = 'a4b3ea61-d252-4fe2-9b49-9e7e69434367';
const REDIRECT_URI = 'http://localhost:8888/lab';
const SCOPES = 'openid email profile urn:globus:auth:scope:transfer.api.globus.org:all';

const GLOBUS_TRANSFER_API_URL = 'https://transfer.api.globusonline.org/v0.10';
const GLOBUS_AUTH_URL = 'https://auth.globus.org/v2/oauth2/authorize';
const GLOBUS_AUTH_TOKEN = 'https://auth.globus.org/v2/oauth2/token';

export const ERROR_CODES: any = {
    'ClientError.NotFound': 'Directory Not Found',
    'EndpointPermissionDenied': 'Endpoint Permission Denied',
    'ClientError.ActivationRequired': 'Endpoint Activation Required',
    'ExternalError.DirListingFailed.NotDirectory': 'Not a Directory',
    'ServiceUnavailable': 'Server Under Maintenance',
    'ExternalError.DirListingFailed.GCDisconnected': 'Globus Connect Personal Not Running',
    'ExternalError.DirListingFailed': 'Directory Listing Failed',
    'ExternalError.DirListingFailed.PermissionDenied': 'Permission Denied'
};

export let TRANSFER_ACCESS_TOKEN = '';
export let globusAuthorized = new PromiseDelegate<void>();
globusAuthorized.promise.then((data:any) => {
    // FIXME not sure where the best place for this variable is. Could be here or inside of client.ts
    TRANSFER_ACCESS_TOKEN = data.other_tokens[0].access_token;
});

// FIXME definitely not the best way to do this. verifier needs to be read in both oauthSignIn and exchangeOAuth
let VERIFIER = '';
let CHALLENGE = '';

// TODO : Protect tokens, Cross-Site Request Forgery protection using "state" urlParam
/**
 * 0Auth2SignIn protocol. Retrieves a 0Auth2Token shown to the user in the popup window
 */
export function oauth2SignIn() {
    generateVerifier();
    generateCodeChallenge();

    // Globus's OAuth 2.0 endpoint for requesting an access token
    let oauth2Endpoint = GLOBUS_AUTH_URL;

    // Create <form> element to submit parameters to OAuth 2.0 endpoint.
    let form: HTMLFormElement = document.createElement('form');
    form.method = 'GET'; // Send as a GET request.
    form.action = oauth2Endpoint;
    form.target = 'popUp';

    // TODO get the auth token from globus auth API. Contact with Globus staff needed
    let popup = window.open('', 'popUp', 'height=500,width=500,resizable,scrollbars');
    let timer = setInterval(async () => {
       try {
           let url = new URL(popup.location.href);
           popup.close();
           await exchangeOAuth2Token(url.searchParams.get('code'))
               .then(data => {
                   clearInterval(timer);
                   globusAuthorized.resolve(data);
               })
               .catch(e => console.log(e));
       }
       catch (e) {}
    }, 1000);

    // Parameters to pass to OAuth 2.0 endpoint.
    let params: any = {
        'client_id': CLIENT_ID,
        'redirect_uri': REDIRECT_URI,
        'scope': SCOPES,
        'state': '_default',
        'response_type': 'code',
        'code_challenge': CHALLENGE,
        'code_challenge_method': 'S256',
        'access_type': 'offline'
    };

    // Add form parameters as hidden input values.
    for (let p in params) {
        let input: HTMLInputElement = document.createElement('input');
        input.type = 'hidden';
        input.name = p;
        input.value = params[p];
        form.appendChild(input);
    }

    // Add form to page and submit it to open the OAuth 2.0 endpoint.
    document.body.appendChild(form);
    form.submit();
}

/**
 * Exchanges a 0Auth2Token for Globus access tokens
 * @param {string} token
 * @returns a promise containing a json object with the access tokens
 */
export async function exchangeOAuth2Token(token: string) {
    // Globus's OAuth 2.0 endpoint for requesting an access token
    let oauth2Endpoint = GLOBUS_AUTH_TOKEN;

    // Parameters to pass to OAuth 2.0 endpoint.
    let params: any = {
        'client_id': CLIENT_ID,
        'redirect_uri': REDIRECT_URI,
        'grant_type': 'authorization_code',
        'code': token,
        'code_verifier': VERIFIER
    };

    let formData = queryParams(params);

    let fetchAccessToken: Promise<any> = new Promise<any>((resolve, reject) =>
        fetch(oauth2Endpoint, {
            method: 'POST',
            body: formData,
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            }
        }).then(function(response) {
            if (response.status >= 400) {
                reject(response.status);
            }
            return response.json();
        }).then(function(data) {
            resolve(data);
        })
    );

    return await fetchAccessToken;
}

/**
 * Sign a user out of their Globus account.
 *
 * @returns a promise resolved when sign-out is complete.
 */
export async function signOut() {
    // Invalidate the globusAuthorized promise and set up a new one.
    return globusAuthorized = new PromiseDelegate<void>();
}

export function activateEndpoint(endpointId: string): Promise<void> {
    return new Promise<void>((resolve) =>
        fetch(`${GLOBUS_TRANSFER_API_URL}/endpoint/${endpointId}/autoactivate`, {
            method: 'POST',
            headers: {'Authorization': `Bearer ${TRANSFER_ACCESS_TOKEN}`},
            body: ''
        }).then(response => {
            return response.json();
        }).then(data => {
            // TODO Deal with failed activations
            resolve();
        }));
}

export function listDirectoryContents(endpointId: string, dirPath: string) {
    return new Promise<any>((resolve) =>
        fetch(`${GLOBUS_TRANSFER_API_URL}/operation/endpoint/${endpointId}/ls?path=${dirPath}`, {
            method: 'GET',
            headers: {'Authorization': `Bearer ${TRANSFER_ACCESS_TOKEN}`},
        }).then(response => {
            resolve(response.json());
        })
    );
}

export function endpointSearch(query: string) {
    return new Promise<any>((resolve) =>
        fetch(`${GLOBUS_TRANSFER_API_URL}/endpoint_search?filter_fulltext=${query}`, {
            method: 'GET',
            headers: {'Authorization': `Bearer ${TRANSFER_ACCESS_TOKEN}`}
        }).then(response => {
            resolve(response.json());
        }));
}

export async function transferFile(items: any, sourceId: string, destinationId: string) {
    let submissionId = await getSubmissionId();

    let transfer: any = {
        'DATA_TYPE': 'transfer',
        'submission_id': submissionId,
        'source_endpoint': sourceId,
        'destination_endpoint': destinationId,
        'DATA': items,
        'notify_on_succeeded': false
    };

    return new Promise<any>((resolve, reject) => {
        fetch(`${GLOBUS_TRANSFER_API_URL}/transfer`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${TRANSFER_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(transfer)
        }).then(async response => {
            if (response.status >= 400) {
                reject(await response.json())
            }
            else {
                resolve(await response.json());
            }
        });
    });
}

function getSubmissionId() {
    return new Promise<any>((resolve) =>
        fetch(`${GLOBUS_TRANSFER_API_URL}/submission_id`, {
            method: 'GET',
            headers: {'Authorization': `Bearer ${TRANSFER_ACCESS_TOKEN}`}
        }).then(response => {
            return response.json();
        }).then(data => {
            resolve(data.value);
        }));
}

function generateVerifier() {
    VERIFIER = CryptoJS.lib.WordArray.random(32).toString();
}

function generateCodeChallenge() {
    CHALLENGE = CryptoJS.SHA256(VERIFIER)
        .toString(CryptoJS.enc.Base64)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}