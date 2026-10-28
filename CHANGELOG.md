# Changelog

## [0.3.0](https://github.com/getstratum/stratum/compare/v0.2.0...v0.3.0) (2026-10-28)


### Features

* **chart:** SLO burn-rate alerting rules for the gateway, tested in CI ([#73](https://github.com/getstratum/stratum/issues/73)) ([cd262ee](https://github.com/getstratum/stratum/commit/cd262eec2c340f146b3a0f233dbdf6b52d71e152))
* **console:** alerts are sent, by email and Slack webhook ([#70](https://github.com/getstratum/stratum/issues/70)) ([c640f51](https://github.com/getstratum/stratum/commit/c640f51c1ba0776cbe9052e70cd921d6ed554d45))
* **console:** sign in to your own applications with the console account ([#80](https://github.com/getstratum/stratum/issues/80)) ([f54be1e](https://github.com/getstratum/stratum/commit/f54be1ea49ec659b5f05c2f15a26507f4ab98576))
* **console:** the estimated environmental impact of each request ([#88](https://github.com/getstratum/stratum/issues/88)) ([8ec6ee6](https://github.com/getstratum/stratum/commit/8ec6ee66a4ae295be6988bb08be9cea9551fe990))
* **deploy/gcp:** people sign in to applications through the console ([#81](https://github.com/getstratum/stratum/issues/81)) ([f435c11](https://github.com/getstratum/stratum/commit/f435c1122a00b7faa6736a2ab7b64f3fa2674d86))
* estimated emissions in the console, Stratum in one command, and the README for 0.3 ([#90](https://github.com/getstratum/stratum/issues/90)) ([f7a29f7](https://github.com/getstratum/stratum/commit/f7a29f7db3e3f30f11c414254cc080ba3bd64eba))
* **gateway:** GenAI semantic-convention metrics on /metrics ([#71](https://github.com/getstratum/stratum/issues/71)) ([8f69c4e](https://github.com/getstratum/stratum/commit/8f69c4ee7b3972da8834a064ec2d6266cb955627))
* **gateway:** GET /v1/models lists what the caller's policy allows ([#78](https://github.com/getstratum/stratum/issues/78)) ([b97d43e](https://github.com/getstratum/stratum/commit/b97d43e5cf13b92b916510eed47b95f965570e98))
* instructions for people, from the team's policy ([#87](https://github.com/getstratum/stratum/issues/87)) ([6fd849b](https://github.com/getstratum/stratum/commit/6fd849b54b68c759c0690595f6f4c09b997d7308))
* keys that act on behalf of people (X-Stratum-User) ([#77](https://github.com/getstratum/stratum/issues/77)) ([adf0241](https://github.com/getstratum/stratum/commit/adf0241239e3610e6831e6680c9f146c1cdffc18))
* limits that cut: quota floor, US$ budgets, max tokens per request ([#68](https://github.com/getstratum/stratum/issues/68)) ([53168d2](https://github.com/getstratum/stratum/commit/53168d2e2cf57931e858277648704984d06f1c0c))
* request labels (X-Stratum-Labels) and Consumo by label ([#79](https://github.com/getstratum/stratum/issues/79)) ([cabf371](https://github.com/getstratum/stratum/commit/cabf3719707b67a588fbd2405aa54cfe92e2ad16))


### Bug Fixes

* **deploy/gcp:** bill enabling the APIs to the project, not to gcloud's client ([#86](https://github.com/getstratum/stratum/issues/86)) ([d3ee371](https://github.com/getstratum/stratum/commit/d3ee371370f368d3ef573d858219501e3626bb7a))
* **deploy/gcp:** enable the APIs one at a time, only the missing ones ([#85](https://github.com/getstratum/stratum/issues/85)) ([f42f9f9](https://github.com/getstratum/stratum/commit/f42f9f98c6914b1d8d9d1e8e2e7afe3fe4561f9b))
* **deploy/gcp:** retry enabling the APIs on a new project ([#84](https://github.com/getstratum/stratum/issues/84)) ([e49f2e5](https://github.com/getstratum/stratum/commit/e49f2e54a04371076e05d39675d0194520ad9c30))
* **gateway:** Go 1.26.10, for GO-2026-6809 in crypto/x509 ([#82](https://github.com/getstratum/stratum/issues/82)) ([b50522e](https://github.com/getstratum/stratum/commit/b50522ebe17205eb875e99f784927f336d85be4a))
* Go 1.26.10 for GO-2026-6809 (go.mod and the images) ([#83](https://github.com/getstratum/stratum/issues/83)) ([e6d40e5](https://github.com/getstratum/stratum/commit/e6d40e5ca389813f5171b3f28e17323b0d89853a))

## [0.2.0](https://github.com/getstratum/stratum/compare/v0.1.1...v0.2.0) (2026-10-20)


### Features

* a daily model catalog feed; orgs turn models off and set prices ([#55](https://github.com/getstratum/stratum/issues/55)) ([a720cc4](https://github.com/getstratum/stratum/commit/a720cc486a126d5442a26b5ba7722486e2422940))
* **console:** 75 more providers from a curated catalog, with search ([#53](https://github.com/getstratum/stratum/issues/53)) ([becd1a8](https://github.com/getstratum/stratum/commit/becd1a8b19958a29fc9ac3b6ea2412dafab6c097))
* **console:** create and delete teams; honest limits; es-UY numbers ([#56](https://github.com/getstratum/stratum/issues/56)) ([73f1e60](https://github.com/getstratum/stratum/commit/73f1e60b1548068ffa837063348bac5d2a07cfb4))
* **deploy:** Helm chart for the control plane, migrations image ([#58](https://github.com/getstratum/stratum/issues/58)) ([029427e](https://github.com/getstratum/stratum/commit/029427e971eb98341ffa823d0ca0a697f69c6fdd))
* **gcp:** the kit installs the control plane with its Helm chart ([#60](https://github.com/getstratum/stratum/issues/60)) ([7c01c14](https://github.com/getstratum/stratum/commit/7c01c14ac82a2deb31f46cc827f24083528c8790))
* **mock-llm:** token usage that follows the request (MOCK_USAGE) ([#62](https://github.com/getstratum/stratum/issues/62)) ([ec488cb](https://github.com/getstratum/stratum/commit/ec488cbc46589f39d4adadfa6da28bf2ddf02367))


### Bug Fixes

* **chart:** charts in the repository name the released version ([#66](https://github.com/getstratum/stratum/issues/66)) ([81c6246](https://github.com/getstratum/stratum/commit/81c6246a36908c80fb1221c7302eb71e00047c6c))
* **chart:** control plane probes tolerate a busy node ([#63](https://github.com/getstratum/stratum/issues/63)) ([67afb09](https://github.com/getstratum/stratum/commit/67afb0937e6f9aadb53f3fcb1aa5cdbf7f414148))
* **control-plane:** stratum-admin starts in the container image ([#57](https://github.com/getstratum/stratum/issues/57)) ([8d23d41](https://github.com/getstratum/stratum/commit/8d23d41339420df5e406fc569e6f7ef05943dacd))
* **migrations:** the image can read its own files ([#61](https://github.com/getstratum/stratum/issues/61)) ([397b823](https://github.com/getstratum/stratum/commit/397b8238c64f09af309cd89b3c63331669ac2242))

## [0.1.1](https://github.com/getstratum/stratum/compare/v0.1.0...v0.1.1) (2026-10-18)


### Bug Fixes

* **release:** publish artifacts when release-please creates a release ([#49](https://github.com/getstratum/stratum/issues/49)) ([d493884](https://github.com/getstratum/stratum/commit/d493884de6c3fc639d5e4792e577acaa62c24dc5))
* **release:** sign the chart with registry credentials ([#52](https://github.com/getstratum/stratum/issues/52)) ([23c196e](https://github.com/getstratum/stratum/commit/23c196e2bf20a943a3d9e68768a342ff0ada8579))

## 0.1.0 (2026-10-18)


### Features

* an agent's fixed model, set in the console, applied by gateways ([#34](https://github.com/getstratum/stratum/issues/34)) ([e93aa3f](https://github.com/getstratum/stratum/commit/e93aa3f66a768c49a51d9203210a13b8614c2741))
* **console:** audit log, request_logs partitions and functional tests ([#29](https://github.com/getstratum/stratum/issues/29)) ([40c5efd](https://github.com/getstratum/stratum/commit/40c5efd39f1f2b1c482ffae593d679d0cebdb0f1))
* **console:** second factor (TOTP), required for Owner and Admin ([#35](https://github.com/getstratum/stratum/issues/35)) ([837c66a](https://github.com/getstratum/stratum/commit/837c66a3441ad090c4f5b10a57e7e26c205e859f))
* **console:** the new console design, Modelos, and Consumo by team, agent, person, model and provider ([#39](https://github.com/getstratum/stratum/issues/39)) ([d4eadd7](https://github.com/getstratum/stratum/commit/d4eadd7806d560a89466ed8f5c633ed6c3655605))
* **control-plane:** agent keys reach gateways; providers and gateways from the console ([#28](https://github.com/getstratum/stratum/issues/28)) ([f79a851](https://github.com/getstratum/stratum/commit/f79a8518e1ba14b19265c3b52e9b3fde8c982840))
* **control-plane:** console access control: roles, sessions, org sco… ([#27](https://github.com/getstratum/stratum/issues/27)) ([90358ee](https://github.com/getstratum/stratum/commit/90358eed9b14ff45fab0ba06e119d9fc42b4ac05))
* **control-plane:** move to Next.js 16 and React 19, fix migrations ([#11](https://github.com/getstratum/stratum/issues/11)) ([1351550](https://github.com/getstratum/stratum/commit/13515500bc45be538e48e0cbad7ec9e8e624384d))
* **deploy:** GCP reference deployment with failure tests ([#16](https://github.com/getstratum/stratum/issues/16)) ([ebbc9b7](https://github.com/getstratum/stratum/commit/ebbc9b7dcba86c8ef12b4ae0c73f1883ebf07807))
* **deploy:** Helm chart for a highly available gateway; HA is open source ([#14](https://github.com/getstratum/stratum/issues/14)) ([0fbacc8](https://github.com/getstratum/stratum/commit/0fbacc8437915b666f9470955eef0dfedb4bc65c))
* **gateway:** retries before the first byte and a breaker per provider ([#36](https://github.com/getstratum/stratum/issues/36)) ([b203742](https://github.com/getstratum/stratum/commit/b203742b787d6482feae7b393b7bf552db215b91))
* gateways report each request's usage to the control plane ([#33](https://github.com/getstratum/stratum/issues/33)) ([83c3a99](https://github.com/getstratum/stratum/commit/83c3a998220c08b8245031ee6ad0d73e35f875d8))
* **gateway:** shared quota counters in Valkey, off the request path ([#13](https://github.com/getstratum/stratum/issues/13)) ([5846df7](https://github.com/getstratum/stratum/commit/5846df7d23aea02fc23c3a025951a3a766d35e5e))
* **gateway:** start during a control plane outage from a snapshot co… ([#19](https://github.com/getstratum/stratum/issues/19)) ([d13050d](https://github.com/getstratum/stratum/commit/d13050dcaf883a916930b4663817eb299aa6fb96))
* initial Stratum open-source repository ([31b427a](https://github.com/getstratum/stratum/commit/31b427a5571a9f48f445fb724dd171b2dcafa8cd))
* Valkey over TLS with a private CA and token auth (ADR-0011) ([#44](https://github.com/getstratum/stratum/issues/44)) ([008c1f5](https://github.com/getstratum/stratum/commit/008c1f5cfe02f4ffa8c3359a451a0972d8006456))


### Bug Fixes

* **ci:** build with Go 1.26 and skip Scorecard on private repos ([#2](https://github.com/getstratum/stratum/issues/2)) ([6f5ae20](https://github.com/getstratum/stratum/commit/6f5ae203595b3f611264f43f8518e388150a64c5))
* **control-plane:** every change that affects a gateway raises the sy… ([#20](https://github.com/getstratum/stratum/issues/20)) ([fd6132f](https://github.com/getstratum/stratum/commit/fd6132f67b952f403f3d26b7db90d2a4891d3157))
* **control-plane:** new installations start empty, without demo data ([#42](https://github.com/getstratum/stratum/issues/42)) ([ed63be3](https://github.com/getstratum/stratum/commit/ed63be3ecf5e53cdd07bd510373ca10d38ce4db4))
* **deploy:** GCP kit fixes from the first real run; attribute test fa… ([#18](https://github.com/getstratum/stratum/issues/18)) ([99da9b3](https://github.com/getstratum/stratum/commit/99da9b3654a0a2306ca3dde09175d371480a9822))
* **deploy:** GCP test harness and deploy fixes from the 2026-10-16 run ([#32](https://github.com/getstratum/stratum/issues/32)) ([04247b8](https://github.com/getstratum/stratum/commit/04247b8952371e554b069a8bcfb53e0bd7824060))
* model aliases in policies and costs; explicit providers and models in policies ([#38](https://github.com/getstratum/stratum/issues/38)) ([e4231cc](https://github.com/getstratum/stratum/commit/e4231cc2b91959bfc4fc800c25e06275633b151c))
