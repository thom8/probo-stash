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
