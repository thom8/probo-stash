# Probo Stash Handler

The stash integration service for Probo.ci.

## Installation

    npm install

## Starting the app

    ./bin/probo-stash-handler -c config.yaml


## Configuring a Stash repo for Probo

In order for Stash to support Probo, install the following Plugins. The plugins can be installed directly from the Stash Plugin Manager (https://stash:7990/plugins/servlet/upm).

1. [Stash Archive Plugin](https://marketplace.atlassian.com/plugins/com.atlassian.stash.plugin.stash-archive/versions#b131) - for downloading tarballs at a specific commit
1. [Stash Web Post Hooks Plugin](https://marketplace.atlassian.com/plugins/com.atlassian.stash.plugin.stash-web-post-receive-hooks-plugin/versions#b21) - for triggering webhooks for (all) commits

To enable a Stash repo for Probo:
1. Sync repos in web UI
1. Enable the project
1. Add a webhook to the Stash Web Post Hooks Plugin in the repository settings under **Workflow** > **Hooks**: https://app.probo.ci/stash-webhook


# Set up local Stash (Bitbucket Server) instance to test with

## Install server
Follow the instructions on https://hub.docker.com/r/atlassian/stash/, also replicated here.

Set permissions for the data directory so that the runuser can write to it (one-time process):

    docker run -u root -v /data/stash:/var/atlassian/application-data/stash atlassian/stash chown -R daemon  /var/atlassian/application-data/stash

Start Atlassian Stash:

    docker run -v /data/stash:/var/atlassian/application-data/stash --name="stash" -d -p 7990:7990 -p 7999:7999 atlassian/stash

Success. Stash is now available on http://localhost:7990

**Note:** Stash 4.0+ (Bitbucket Server) is available at https://hub.docker.com/r/atlassian/bitbucket-server/

## Provision stash-handler

### OAuth private and public keys

A private-public key pair is required to establish OAuth authorisation with an Atlassian product. The private key and public key can be generated using openssl:

    todo...
