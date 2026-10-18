# Changelog

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
