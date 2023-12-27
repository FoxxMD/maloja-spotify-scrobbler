import {addAsync, Router} from '@awaitjs/express';
import express from 'express';
import bodyParser from 'body-parser';
import passport from 'passport';
import session from 'express-session';
import path from "path";
import { getRoot } from "../ioc";
import {Logger} from "@foxxmd/winston";
import { LogInfo } from "../../core/Atomic";
import { setupApi } from "./api";
import { getAddress, mergeArr, parseBool } from "../utils";
import {stripIndents} from "common-tags";
import {ErrorWithCause} from "pony-cause";
import {projectDir} from "../common";

const buildDir = path.join(process.cwd() + "/build");

const app = addAsync(express());
const router = Router();

export const initServer = async (parentLogger: Logger, initialOutput: LogInfo[] = []) => {

    const logger = parentLogger.child({labels: ['API']}, mergeArr);

    try {
        app.use(router);
        app.use(bodyParser.json());
        app.use(
            bodyParser.urlencoded({
                extended: true,
            })
        );

        app.use(express.static(buildDir));

        app.use(session({secret: 'keyboard cat', resave: false, saveUninitialized: false}));
        app.use(passport.initialize());
        app.use(passport.session());

        const root = getRoot();

        const isProd = root.get('isProd');
        const apiPort = root.get('apiPort');
        const mainPort = root.get('mainPort');
        const port = root.get('port');
        const local = root.get('localUrl');
        const localDefined = root.get('hasDefinedBaseUrl');

        setupApi(app, logger, initialOutput);

        app.get("/*", function (req, res) {
            if (!isProd) {
                logger.warn(`In development environment this path (on port ${apiPort}) does nothing. You most likely want port ${mainPort}`)
            }
            res.sendFile(path.join(buildDir, "index.html"));
        });

        const backendPort = isProd ? port : apiPort;
        app.listen(backendPort);

        const addy = getAddress();
        const addresses: string[] = [];
        let dockerHint = '';
        if (parseBool(process.env.IS_DOCKER) && addy.v4 !== undefined && addy.v4.includes('172')) {
            dockerHint = stripIndents`
            --- HINT ---
            MS is likely being run in a container with BRIDGE networking which means the above addresses are not accessible from outside this container.
            To ensure the container is accessible make sure you have mapped the *container* port ${port} to a *host* port. https://foxxmd.github.io/multi-scrobbler/docs/installation#networking
            The container will then be accessible at http://HOST_MACHINE_IP:HOST_PORT${localDefined ? ` (or ${local} since you defined this!)` : ''}
            --- HINT ---
            `;
        }
        for (const [k, v] of Object.entries(addy)) {
            if (v !== undefined) {
                switch (k) {
                    case 'host':
                    case 'v4':
                        addresses.push(`---> ${k === 'host' ? 'Local'.padEnd(14, ' ') : 'Network'.padEnd(14, ' ')} http://${v}:${backendPort}`);
                        break;
                    case 'v6':
                        addresses.push(`---> Network (IPv6) http://[${v}]:${backendPort}`);
                }
            }
        }
        const start = stripIndents`\n
        ${isProd ? 'Server' : 'API Backend'} started:
        ${addresses.join('\n')}${dockerHint !== '' ? `\n${dockerHint}` : ''}`

        logger.info(start);

        if(localDefined) {
            logger.info(`User-defined base URL for UI and redirect URLs (spotify, deezer, lastfm): ${local}`)
        }
    } catch (e) {
        logger.error(new ErrorWithCause('Server crashed with uncaught exception', {cause: e}));
    }
}
