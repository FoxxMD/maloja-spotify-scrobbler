import React, {Fragment, useCallback} from 'react';
import StatusCardSkeleton, {StatusCardSkeletonData} from "./StatusCardSkeleton";
import SkeletonParagraph from "../skeleton/SkeletonParagraph";
import {Link} from "react-router-dom";
import {sourceAdapter} from "../../status/ducks";
import {RootState} from "../../store";
import {connect, ConnectedProps} from "react-redux";
import Player from "../player/Player";
import './statusCard.scss';

export interface SourceStatusCardData extends StatusCardSkeletonData, PropsFromRedux {
    loading?: boolean
}

const statusToStatusType = (status: string) => {
    const lower = status.toLowerCase();
    if(lower.includes('running') || lower.includes('polling') || lower.includes('awaiting data')) {
        return 'active';
    }
    if(lower.includes('idle')) {
        return 'warn';
    }
    return 'error';
}

const SourceStatusCard = (props: SourceStatusCardData) => {
    const {
        loading = false,
        data,
        data: {
            display,
            name,
            status,
        } = {}
    } = props;
    let header: string | undefined = display;
    let body = <SkeletonParagraph/>;
    const poll = useCallback(async () => {
        const params = new URLSearchParams({type: data.type, name: data.name});
        await fetch(`/api/poll?${params}`, {
            method: 'GET',
        });
    },[data]);
    let startSourceElement = null;
    if(data !== undefined)
    {
        const {
            display,
            name,
            canPoll,
            hasAuth,
            authed,
            status,
            tracksDiscovered,
            hasAuthInteraction,
            type,
            players = {},
            sot,
            supportsUpstreamRecentlyPlayed
        } = data;
        if(type === 'listenbrainz' || type === 'lastfm') {
            header = `${display} (Source)`;
        }

        const platformIds = Object.keys(players);

        const discovered = (!hasAuth || authed) ? <Link to={`/recent?type=${type}&name=${name}`}>Tracks Discovered</Link> : <span>Tracks Discovered</span>;

        let upstreamRecent = null;
        if(supportsUpstreamRecentlyPlayed && (!hasAuth || authed)) {
            upstreamRecent = <div><Link to={`/recent?type=${type}&name=${name}&upstream=1`}>See Recent from Source API</Link></div>;
        }

        if((!hasAuth || authed) && canPoll) {
            startSourceElement = <div onClick={poll} className="capitalize underline cursor-pointer">{status === 'Polling' ? 'Restart' : 'Start'}</div>
        }

        // TODO links
        body = (<div className="statusCardBody">
            {platformIds.map(x => <Player key={x} data={players[x]} sot={sot}/>)}
            <div>{discovered}: {tracksDiscovered}</div>
            {upstreamRecent}
            {canPoll && hasAuthInteraction ? <a target="_blank" href={`/api/source/auth?name=${name}&type=${type}`}>(Re)authenticate</a> : null}
        </div>);
    }
    return (
        <StatusCardSkeleton
            loading={loading}
            title={header}
            subtitle={name}
            status={status}
            subtitleRight={startSourceElement}
            statusType={statusToStatusType(status)}>
                {body}
        </StatusCardSkeleton>
    );
}

const simpleSelectors = sourceAdapter.getSelectors();

const mapStateToProps = (state: RootState, props) => ({
    data: simpleSelectors.selectById(state.sources, props.id)
});

const connector = connect(mapStateToProps);

type PropsFromRedux = ConnectedProps<typeof connector>

export default connector(SourceStatusCard);
