import dayjs from "dayjs";
import {
    readJson,
    writeFile,
    sortByOldestPlayDate,
    sleep,
    parseRetryAfterSecsFromObj,
    combinePartsToString, findCauseByFunc,
} from "../utils";
import SpotifyWebApi from "spotify-web-api-node";
import AbstractSource, { RecentlyPlayedOptions } from "./AbstractSource";
import { SpotifySourceConfig } from "../common/infrastructure/config/source/spotify";
import {
    DEFAULT_POLLING_INTERVAL,
    FormatPlayObjectOptions,
    InternalConfig, NO_DEVICE,
    NO_USER,
    PlayerStateData,
    ReportedPlayerStatus,
    SourceData,
} from "../common/infrastructure/Atomic";
import PlayHistoryObject = SpotifyApi.PlayHistoryObject;
import EventEmitter from "events";
import CurrentlyPlayingObject = SpotifyApi.CurrentlyPlayingObject;
import TrackObjectFull = SpotifyApi.TrackObjectFull;
import ArtistObjectSimplified = SpotifyApi.ArtistObjectSimplified;
import AlbumObjectSimplified = SpotifyApi.AlbumObjectSimplified;
import UserDevice = SpotifyApi.UserDevice;
import MemorySource from "./MemorySource";
import {ErrorWithCause} from "pony-cause";
import { PlayObject } from "../../core/Atomic";
import { buildTrackString, truncateStringToLength } from "../../core/StringUtils";
import {isNodeNetworkException} from "../common/errors/NodeErrors";
import {hasUpstreamError, UpstreamError} from "../common/errors/UpstreamError";

const scopes = ['user-read-recently-played', 'user-read-currently-playing', 'user-read-playback-state', 'user-read-playback-position'];
const state = 'random';

const shortDeviceId = truncateStringToLength(10, '');

export default class SpotifySource extends MemorySource {

    spotifyApi: SpotifyWebApi;
    workingCredsPath: string;

    requiresAuth = true;
    requiresAuthInteraction = true;

    canGetState = false;

    declare config: SpotifySourceConfig;

    constructor(name: any, config: SpotifySourceConfig, internal: InternalConfig, emitter: EventEmitter) {
        super('spotify', name, config, internal, emitter);
        const {
            data: {
                interval = DEFAULT_POLLING_INTERVAL,
            } = {}
        } = config;

        if (interval < 5) {
            this.logger.warn('Interval should probably be 5 seconds or above! Spotify may return 429 response (too many requests)');
        }

        this.workingCredsPath = `${this.configDir}/currentCreds-${name}.json`;
        this.canPoll = true;
        this.canBacklog = true;
    }

    static formatPlayObj(obj: PlayHistoryObject | CurrentlyPlayingObject, options: FormatPlayObjectOptions = {}): PlayObject {

        const {
            newFromSource = false
        } = options;

        let artists: ArtistObjectSimplified[];
        let album: AlbumObjectSimplified;
        let name: string;
        let duration_ms: number;
        let played_at: string;
        let id: string;
        let url: string;
        let playbackPosition: number | undefined;
        let deviceId: string | undefined;


        if (asPlayHistoryObject(obj)) {
            const {
                track,
                played_at: pa
            } = obj;
            const {
                artists: art = [],
                name: n,
                id: i,
                duration_ms: dm,
                album: a,
                external_urls: {
                    spotify,
                } = {}
            } = track;

            played_at = pa;
            artists = art;
            name = n;
            id = i;
            duration_ms = dm;
            album = a;
            url = spotify;

        } else if (asCurrentlyPlayingObject(obj)) {
            const {
                is_playing,
                progress_ms,
                timestamp,
                device: {
                    id: deviceIdentifier,
                    name: deviceName
                } = {},
                item,
            } = obj;
            const {
                artists: art,
                name: n,
                id: i,
                duration_ms: dm,
                album: a,
                external_urls: {
                    spotify,
                } = {}
            } = item as TrackObjectFull;

            played_at = dayjs(timestamp).toISOString();
            artists = art;
            name = n;
            id = i;
            duration_ms = dm;
            album = a;
            url = spotify;
            playbackPosition = progress_ms / 1000;
            deviceId = combinePartsToString([shortDeviceId(deviceIdentifier), deviceName]);

        } else {
            throw new Error('Could not determine format of spotify response data');
        }

        const {name: albumName, artists: albumArtists = []} = album || {};

        const trackArtistIds = artists.map(x => x.id);
        let actualAlbumArtists: ArtistObjectSimplified[] = [];
        if(albumArtists.filter(x => !trackArtistIds.includes(x.id)).length > 0) {
            // only include album artists if they are not the EXACT same as the track artists
            // ...if they aren't the exact same then include all artists, even if they are duplicates of track artists
            actualAlbumArtists = albumArtists;
        }

        return {
            data: {
                artists: artists.map(x => x.name),
                albumArtists: actualAlbumArtists.map(x => x.name),
                album: albumName,
                track: name,
                duration: duration_ms / 1000,
                playDate: dayjs(played_at),
            },
            meta: {
                deviceId: deviceId ?? `${NO_DEVICE}-${NO_USER}`,
                source: 'Spotify',
                trackId: id,
                trackProgressPosition: playbackPosition,
                newFromSource,
                url: {
                    web: url
                }
            }
        };
    }

    buildSpotifyApi = async () => {

        let spotifyCreds = {};
        try {
            spotifyCreds = await readJson(this.workingCredsPath, {throwOnNotFound: false}) as any;
        } catch (e) {
            this.logger.warn('Current spotify credentials file exists but could not be parsed', { path: this.workingCredsPath });
        }

        const {token: accessToken = undefined, refreshToken = undefined} = (spotifyCreds || {}) as any;

        const {
            clientId,
            clientSecret,
            redirectUri,
        } = this.config.data || {};

        const rdUri = redirectUri || `${this.localUrl}/callback`;

        const apiConfig = {
            clientId,
            clientSecret,
            accessToken,
            refreshToken,
        }

        if (Object.values(apiConfig).every(x => x === undefined)) {
            this.logger.info('No values found for Spotify configuration, skipping initialization');
            return;
        }
        // @ts-expect-error TS(2339): Property 'redirectUri' does not exist on type '{ c... Remove this comment to see the full error message
        apiConfig.redirectUri = rdUri;

        const validationErrors = [];

        if (clientId === undefined) {
            validationErrors.push('clientId must be defined');
        }
        if (clientSecret === undefined) {
            validationErrors.push('clientSecret must be defined');
        }
        if (rdUri === undefined) {
            validationErrors.push('redirectUri must be defined');
        }

        if (validationErrors.length !== 0) {
            this.logger.warn(`Configuration was not valid:\*${validationErrors.join('\n')}`);
            throw new Error('Failed to initialize a Spotify source');
        }

        if(accessToken === undefined || refreshToken === undefined) {
            this.logger.info(`No access or refresh token is present. User interaction for authentication is required.`);
            this.logger.info(`Redirect URL that will be used on auth callback: '${rdUri}'`);
        }

        this.spotifyApi = new SpotifyWebApi(apiConfig);
    }

    initialize = async () => {
        if(this.spotifyApi === undefined) {
            await this.buildSpotifyApi();
        }
        this.initialized = true;
        return this.initialized;
    }

    doAuthentication = async () => {
        try {
            if(undefined === this.spotifyApi.getAccessToken()) {
                return false;
            }
            await this.callApi<ReturnType<typeof this.spotifyApi.getMe>>(((api: any) => api.getMe()));
            return true;
        } catch (e) {
            if(isNodeNetworkException(e)) {
                this.logger.error('Could not communicate with Spotify API');
            }
            // this.authFailure = !(e instanceof ErrorWithCause && e.cause !== undefined && isNodeNetworkException(e.cause));
            // this.logger.error(new ErrorWithCause('Could not successfully communicate with Spotify API', {cause: e}));
            // this.authed = false;
            throw e;
        }
    }

    createAuthUrl = () => {
        return this.spotifyApi.createAuthorizeURL(scopes, this.name);
    }

    handleAuthCodeCallback = async ({
        error,
        code
    }: any) => {
        try {
            if (error === undefined) {
                const tokenResponse = await this.spotifyApi.authorizationCodeGrant(code);
                this.spotifyApi.setAccessToken(tokenResponse.body['access_token']);
                this.spotifyApi.setRefreshToken(tokenResponse.body['refresh_token']);
                await writeFile(this.workingCredsPath, JSON.stringify({
                    token: tokenResponse.body['access_token'],
                    refreshToken: tokenResponse.body['refresh_token']
                }));
                this.logger.info('Got token from code grant authorization!');
                return true;
            } else {
                this.logger.warn('Callback contained an error! User may have denied access?')
                this.logger.error(error);
                return error;
            }
        } catch (e) {
            throw e;
        }
    }

    getRecentlyPlayed = async (options: RecentlyPlayedOptions = {}) => {
        const plays: SourceData[] = [];
        if(this.canGetState) {
            const state = await this.getCurrentPlaybackState();
            if(state.playerState !== undefined) {
                if(state.device.is_private_session) {
                    this.logger.debug(`Will not track play on Device ${state.device.name} because it is in a private session.`);
                } else {
                    plays.push(state.playerState);
                }
            }
        } else {
            const currPlay = await this.getNowPlaying();
            if(currPlay !== undefined) {
                plays.push(currPlay);
            }
        }
        return this.processRecentPlays(plays);
    }

    getPlayHistory = async (options: RecentlyPlayedOptions = {}) => {
        const {limit = 20} = options;
        const func = (api: SpotifyWebApi) => api.getMyRecentlyPlayedTracks({
            limit
        });
        const result = await this.callApi<ReturnType<typeof this.spotifyApi.getMyRecentlyPlayedTracks>>(func);
        return result.body.items.map((x: any) => SpotifySource.formatPlayObj(x)).sort(sortByOldestPlayDate);
    }

    getNowPlaying = async () => {
        const func = (api: SpotifyWebApi) => api.getMyCurrentPlayingTrack();
        const playingRes = await this.callApi<ReturnType<typeof this.spotifyApi.getMyCurrentPlayingTrack>>(func);

        const {body: {item}} = playingRes;
        if(item !== undefined && item !== null) {
           return SpotifySource.formatPlayObj(playingRes.body, {newFromSource: true});
        }
        return undefined;
    }

    getCurrentPlaybackState = async (logError = true): Promise<{device?: UserDevice, playerState?: PlayerStateData}> => {
        try {
            const funcState = (api: SpotifyWebApi) => api.getMyCurrentPlaybackState();
            const res = await this.callApi<ReturnType<typeof this.spotifyApi.getMyCurrentPlaybackState>>(funcState);
            const {
                body: {
                    device,
                    item,
                    is_playing,
                    timestamp,
                    progress_ms,
                } = {}
            } = res;
            if(device !== undefined) {
                let status: ReportedPlayerStatus = 'stopped';
                if(is_playing) {
                    status = 'playing';
                } else if(item !== null && item !== undefined) {
                    status = 'paused';
                }
                return {
                    device,
                    playerState: {
                        platformId: [combinePartsToString([shortDeviceId(device.id), device.name]), NO_USER],
                        status,
                        play: item !== null && item !== undefined ? SpotifySource.formatPlayObj(res.body, {newFromSource: true}) : undefined,
                        timestamp: dayjs(timestamp),
                        position: progress_ms !== null && progress_ms !== undefined ? progress_ms / 1000 : undefined,
                    }
                }
            }

            return {};
        } catch (e) {
            if(hasApiError(e)) {
                throw new UpstreamError('Error occurred while trying to retrieve current playback state', {cause: e});
            }
            throw new ErrorWithCause('Error occurred while trying to retrieve current playback state', {cause: e});
        }
    }

/*    getDevices = async () => {
        const funcDevice = (api: SpotifyWebApi) => api.getMyDevices();
        return await this.callApi<ReturnType<typeof this.spotifyApi.getMyDevices>>(funcDevice);
    }*/

    callApi = async <T>(func: (api: SpotifyWebApi) => Promise<any>, retries = 0): Promise<T> => {
        const {
            maxRequestRetries = 1,
            retryMultiplier = 2,
        } = this.config.data;
        try {
            return await func(this.spotifyApi);
        } catch (e) {
            const spotifyError = new UpstreamError('Spotify API call failed', {cause: e});
            if (e.statusCode === 401 && !hasApiPermissionError(e)) {
                if (this.spotifyApi.getRefreshToken() === undefined) {
                    throw new Error('Access token was not valid and no refresh token was present')
                }
                this.logger.debug('Access token was not valid, attempting to refresh');

                try {
                    const tokenResponse = await this.spotifyApi.refreshAccessToken();
                    const {
                        body: {
                            access_token,
                            // spotify may return a new refresh token
                            // if it doesn't then continue to use the last refresh token we received
                            refresh_token = this.spotifyApi.getRefreshToken(),
                        } = {}
                    } = tokenResponse;
                    this.spotifyApi.setAccessToken(access_token);
                    await writeFile(this.workingCredsPath, JSON.stringify({
                        token: access_token,
                        refreshToken: refresh_token,
                    }));
                } catch (refreshError) {
                    const error = new UpstreamError('Refreshing access token encountered an error', {cause: refreshError});
                    this.logger.error(error);
                    this.logger.error(spotifyError);
                    throw error;
                }

                try {
                    return await func(this.spotifyApi);
                } catch (ee) {
                    const secondSpotifyError = new UpstreamError('Spotify API call failed even after refreshing token', {cause: ee});
                    this.logger.error(secondSpotifyError);
                    this.logger.error(spotifyError);
                    throw secondSpotifyError;
                }
            } else if(maxRequestRetries > retries) {
                const retryAfter = parseRetryAfterSecsFromObj(e) ?? (retryMultiplier * (retries + 1));
                this.logger.warn(`Request failed but retries (${retries}) less than max (${maxRequestRetries}), retrying request after ${retryAfter} seconds...`);
                await sleep(retryAfter * 1000);
                return this.callApi(func, retries + 1);
            } else {
                const error = new UpstreamError(`Request failed on retry (${retries}) with no more retries permitted (max ${maxRequestRetries})`, {cause: e});
                this.logger.error(error);
                throw error;
            }
        }
    }

    onPollPreAuthCheck = async () => {
        if (this.spotifyApi === undefined) {
            this.logger.warn('Cannot poll spotify without valid credentials configuration')
            return false;
        }
        return true;
    }

    onPollPostAuthCheck = async () => {
        // test capabilities
        try {
            await this.getCurrentPlaybackState(false);
            this.canGetState = true;
        } catch (e) {
            if(hasApiPermissionError(e)) {
                this.logger.warn('multi-scrobbler does not have sufficient permissions to access Spotify API "Get Playback State". MS will continue to work but accuracy for determining if/when a track played from a Spotify Connect device (smart device controlled through Spotify app) may be degraded. To fix this re-authenticate MS with Spotify and restart polling.');
                this.canGetState = false;
                return false;
            } else {
                if(!hasUpstreamError(e)) {
                    this.logger.error(e);
                }
                return false;
            }
        }

        return true;
    }

    protected getBackloggedPlays = async () => {
        return await this.getPlayHistory({formatted: true});
    }
}

const asPlayHistoryObject = (obj: object): obj is PlayHistoryObject => {
    return 'played_at' in obj;
}

const asCurrentlyPlayingObject = (obj: object): obj is CurrentlyPlayingObject => {
    return 'is_playing' in obj;
}

const hasApiPermissionError = (e: Error): boolean => {
    return findCauseByFunc(e, (err) => {
        return err.message.includes('Permissions missing');
    }) !== undefined;
}

const hasApiAuthError = (e: Error): boolean => {
    return findCauseByFunc(e, (err) => {
        return err.message.includes('An authentication error occurred');
    }) !== undefined;
}

const hasApiTimeoutError = (e: Error): boolean => {
    return findCauseByFunc(e, (err) => {
        return err.message.includes('A timeout occurred');
    }) !== undefined;
}

const hasApiError = (e: Error): boolean => {
    return findCauseByFunc(e, (err) => {
        return err.message.includes('while communicating with Spotify\'s Web API.');
    }) !== undefined;
}
