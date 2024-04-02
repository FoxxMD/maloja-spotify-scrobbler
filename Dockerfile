FROM lsiobase/alpine:3.18 as base

ENV TZ=Etc/GMT

RUN \
  echo "**** install build packages ****" && \
  apk add --no-cache \
    avahi \
    avahi-tools \
    nodejs \
    npm \
    && \
  echo "**** cleanup ****" && \
  rm -rf \
    /root/.cache \
    /tmp/*

RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

ARG data_dir=/config
VOLUME $data_dir
ENV CONFIG_DIR=$data_dir

COPY docker/root/ /

WORKDIR /app

FROM base as build

# would very much like to use YARN for dependency management but its got show-stopping bad design for prod dependencies
# https://github.com/yarnpkg/yarn/issues/6323 -- always downloads devDependencies -- and im not about to migrate to v2 since alpine doesn't support it yet

# copy dep/TS config and install dev dependencies
#COPY --chown=abc:abc package.json tsconfig.json yarn.lock ./
COPY --chown=abc:abc package*.json tsconfig.json ./
COPY --chown=abc:abc patches ./patches

RUN npm ci \
    && chown -R root:root node_modules
#RUN yarn install

COPY --chown=abc:abc . /app

# need to set before build so server/client build is optimized and has constants (if needed)
ENV NODE_ENV=production

RUN npm run build && rm -rf node_modules
#RUN yarn run build && rm -rf node_modules

FROM base as app

#COPY --chown=abc:abc package.json yarn.lock ./
COPY --chown=abc:abc package*.json ./
COPY --chown=abc:abc patches ./patches
COPY --from=build --chown=abc:abc /app/dist /app/dist
COPY --from=build --chown=abc:abc /app/src /app/src
COPY --from=base /usr/local/bin /usr/local/bin
COPY --from=base /usr/local/lib /usr/local/lib

ENV NODE_ENV=production
ENV IS_DOCKER=true
ENV COLORED_STD=true
#
#RUN yarn global add patch-package \
#    && yarn install --production=true \
#    && yarn global remove patch-package \
#    && yarn cache clean --mirror \
#    && chown abc:abc node_modules \
#    && rm -rf node_modules/ts-node \
#    && rm -rf node_modules/typescript

RUN npm ci --omit=dev \
    && npm cache clean --force \
    && chown -R abc:abc node_modules \
    && rm -rf node_modules/@types

ARG webPort=9078
ENV PORT=$webPort
EXPOSE $PORT
