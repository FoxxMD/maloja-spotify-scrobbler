import {mergeArr, parseBool, remoteHostIdentifiers} from "../utils";
import {ExpressWithAsync} from "@awaitjs/express";
import {Logger} from "@foxxmd/winston";
import ScrobbleSources from "../sources/ScrobbleSources";
import bodyParser from "body-parser";
import {WebScrobblerPayload} from "../common/vendor/webscrobbler/interfaces";
import {WebhookNotifier} from "../sources/ingressNotifiers/WebhookNotifier";
import {nonEmptyBody} from "./middleware";
import {WebScrobblerSource} from "../sources/WebScrobblerSource";
import path from "path";

export const setupWebscrobblerRoutes = (app: ExpressWithAsync, parentLogger: Logger, scrobbleSources: ScrobbleSources) => {

    const logger = parentLogger.child({labels: ['Ingress', 'WebScrobbler']}, mergeArr);

    const webScrobblerJsonParser = bodyParser.json({
        type: ['text/*', 'application/json'],
        // verify: function(req, res, buf, encoding) {
        //     // get rawBody
        //     // @ts-ignore
        //     req.rawBody = buf.toString();
        // }
    });
    const webhookIngress = new WebhookNotifier();
    app.postAsync(/\/api\/webscrobbler.*/,
        async function (req, res, next) {
            // track request before parsing body to ensure we at least log that something is happening
            // (in the event body parsing does not work or request is not POST/PATCH)
            webhookIngress.trackIngress(req, true);
            next();
        },
        webScrobblerJsonParser, nonEmptyBody(logger, 'WebScrobbler Extension'), async function (req, res) {
            webhookIngress.trackIngress(req, false);

            res.sendStatus(200);

            const parts = path.parse(req.path);
            const slug = parts.name === 'webscrobbler' ? undefined : parts.name;

            // let cleanPath = req.path;
            // if (cleanPath.charAt(cleanPath.length - 1) === '/') {
            //     cleanPath = cleanPath.slice(0, -1);
            // }
            // const splitPath = cleanPath.split('/');
            // const slug = splitPath[splitPath.length - 1];

            const playerState = WebScrobblerSource.playStateFromRequest(req.body);

            const sources = scrobbleSources.getByType('webscrobbler') as WebScrobblerSource[];
            if (sources.length === 0) {
                logger.warn('Received WebScrobbler payload but no WebScrobbler sources are configured');
            }

            let slugMatched = false;
            for (const source of sources) {
                if (source.matchSlug(slug)) {
                    await source.handle(playerState);
                    slugMatched = true;
                }
            }

            if (!slugMatched) {
                if (slug === undefined) {
                    logger.warn(`Request URL did not have a slug and no WebScrobbler source was configured without a slug.`);
                } else {
                    logger.warn(`No WebScrobbler souce had the given slug '${slug}'`);
                }
            }
        });
}

