{{/* Labels of what this chart renders itself. */}}
{{- define "stratum.labels" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: stratum
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* The pods of one component of this release. The subcharts are named by
     their alias (gateway, control-plane), so their pods carry it. */}}
{{- define "stratum.select" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end -}}

{{/* Every pod of this release. */}}
{{- define "stratum.selectAll" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* A subchart's resource name, as this repository's charts make it: the
     release name when it contains the alias, else release-alias. */}}
{{- define "stratum.subFullname" -}}
{{- if contains .name .root.Release.Name -}}
{{- .root.Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .root.Release.Name .name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/* A public host: global.hosts.<key>, or <prefix>.<global.domain>.
     dict "key" "console" "prefix" "consola" "root" $ */}}
{{- define "stratum.host" -}}
{{- $g := .root.Values.global -}}
{{- $hosts := $g.hosts | default dict -}}
{{- if index $hosts .key -}}
{{- index $hosts .key -}}
{{- else if $g.domain -}}
{{- printf "%s.%s" .prefix $g.domain -}}
{{- end -}}
{{- end -}}

{{/* A pod's user and group, unless the platform assigns them (OpenShift).
     dict "uid" 70 "root" $ */}}
{{- define "stratum.podIdentity" -}}
{{- if not .root.Values.global.openshift -}}
runAsUser: {{ .uid }}
runAsGroup: {{ .uid }}
fsGroup: {{ .uid }}
{{- end -}}
{{- end -}}

{{- define "stratum.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities: { drop: [ALL] }
{{- end -}}

{{/* An image of this repository, at the chart's version unless a tag is given. */}}
{{- define "stratum.image" -}}
{{- printf "%s:%s" .image (.tag | default .root.Chart.AppVersion) -}}
{{- end -}}

{{/* The console's image, as the control-plane chart runs it: Jobs that
     need its code (bootstrap, demo) use the same. */}}
{{- define "stratum.consoleImage" -}}
{{- $cp := index .Values "control-plane" -}}
{{- $img := $cp.image | default dict -}}
{{- $repo := $img.repository | default "ghcr.io/getstratum/stratum-control-plane" -}}
{{- if $img.digest -}}
{{- printf "%s@%s" $repo $img.digest -}}
{{- else -}}
{{- printf "%s:%s" $repo ($img.tag | default .Chart.AppVersion) -}}
{{- end -}}
{{- end -}}

{{/* Where PostgreSQL answers inside the cluster. */}}
{{- define "stratum.databaseHost" -}}
{{- $mode := .Values.postgresql.mode -}}
{{- if eq $mode "bundled" -}}
{{- printf "%s-postgresql" .Release.Name -}}
{{- else if eq $mode "cnpg" -}}
{{- printf "%s-rw" (include "stratum.subFullname" (dict "name" "cnpg" "root" .)) -}}
{{- else -}}
{{- .Values.postgresql.external.host -}}
{{- end -}}
{{- end -}}

{{/* A container that waits until a URL answers 200: the console's image
     has node. dict "name" "wait-console" "url" "http://..." "root" $ */}}
{{- define "stratum.waitFor" -}}
- name: {{ .name }}
  image: {{ include "stratum.consoleImage" .root | quote }}
  command:
    - node
    - --input-type=module
    - -e
    - |
      const url = process.argv[1]
      for (let i = 1; ; i++) {
        try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (r.ok) break } catch {}
        if (i % 12 === 0) console.log(`waiting for ${url}`)
        await new Promise(r => setTimeout(r, 5000))
      }
    - {{ .url | quote }}
  securityContext: {{- include "stratum.containerSecurity" .root | nindent 4 }}
  resources:
    requests: { cpu: 10m, memory: 64Mi }
    limits: { memory: 128Mi }
{{- end -}}

{{/* Values that would install something that cannot work. */}}
{{- define "stratum.validate" -}}
{{- $v := .Values -}}
{{- $cp := index $v "control-plane" -}}
{{- if not (has $v.secrets.mode (list "existing" "generate" "demo")) -}}
{{- fail "secrets.mode must be existing, generate or demo" -}}
{{- end -}}
{{- $pg := $v.postgresql.mode -}}
{{- if not (has $pg (list "external" "cnpg" "bundled")) -}}
{{- fail "postgresql.mode must be external, cnpg or bundled" -}}
{{- end -}}
{{- if ne (eq $pg "cnpg") ($v.cnpg.enabled | default false) -}}
{{- fail "postgresql.mode cnpg and cnpg.enabled go together: set both, or neither" -}}
{{- end -}}
{{- if and (eq $pg "bundled") $v.global.openshift -}}
{{- fail "the bundled PostgreSQL does not run on OpenShift: postgresql.mode cnpg (CloudNativePG from OperatorHub) or external" -}}
{{- end -}}
{{- if and (eq $pg "external") (eq $v.secrets.mode "generate") (not $v.postgresql.external.host) -}}
{{- fail "secrets.mode generate with postgresql.mode external: set postgresql.external.host (the chart writes DATABASE_URL from it)" -}}
{{- end -}}
{{- if and (eq $v.secrets.mode "demo") (not $v.demo.enabled) -}}
{{- fail "secrets.mode demo is for the demo only (demo.enabled: true); use generate or existing" -}}
{{- end -}}
{{- if and $v.demo.enabled (ne $v.secrets.mode "demo") -}}
{{- fail "demo.enabled needs secrets.mode demo: the demo registers a gateway with fixed, public credentials" -}}
{{- end -}}
{{- if and $v.demo.enabled (not $cp.enabled) -}}
{{- fail "demo.enabled needs the console here (control-plane.enabled: true)" -}}
{{- end -}}
{{- if and $v.bootstrap.enabled (not $cp.enabled) -}}
{{- fail "bootstrap.enabled needs the console here (control-plane.enabled: true)" -}}
{{- end -}}
{{- if and $v.bootstrap.enabled (not $v.bootstrap.orgName) -}}
{{- fail "bootstrap.enabled: set bootstrap.orgName (and bootstrap.ownerEmail for its first Owner)" -}}
{{- end -}}
{{- if and $v.bootstrap.enabled $v.demo.enabled -}}
{{- fail "bootstrap and demo do the same first run: turn one off" -}}
{{- end -}}
{{- if and $cp.enabled (eq $v.gateway.controlPlane.url "http://stratum-control-plane") (ne .Release.Name "stratum") -}}
{{- fail (printf "the gateways look for the console at http://stratum-control-plane: name the release \"stratum\", or set gateway.controlPlane.url to http://%s" (include "stratum.subFullname" (dict "name" "control-plane" "root" .))) -}}
{{- end -}}
{{- if not (has $v.expose.type (list "none" "ingress" "route" "gatewayApi")) -}}
{{- fail "expose.type must be none, ingress, route or gatewayApi" -}}
{{- end -}}
{{- if and (ne $v.expose.type "none") (not $v.global.domain) (not $v.global.hosts) -}}
{{- fail "expose: set global.domain (consola.<domain>, gateway.<domain>) or global.hosts" -}}
{{- end -}}
{{- if and (eq $v.expose.type "gatewayApi") (not $v.expose.parentRefs) -}}
{{- fail "expose.type gatewayApi: set expose.parentRefs (the Gateway the HTTPRoutes attach to)" -}}
{{- end -}}
{{- if and $v.valkey.enabled (not $v.valkey.auth.usersExistingSecret) -}}
{{- fail "valkey.auth.usersExistingSecret is required (secrets.valkey's name)" -}}
{{- end -}}
{{- if and (ne $v.gateway.existingSecret $v.secrets.gateway) (ne $v.secrets.mode "existing") -}}
{{- fail "gateway.existingSecret must be secrets.gateway's name: the chart makes that Secret" -}}
{{- end -}}
{{- if and $cp.enabled (ne $cp.existingSecret $v.secrets.controlPlane) (ne $v.secrets.mode "existing") -}}
{{- fail "control-plane.existingSecret must be secrets.controlPlane's name: the chart makes that Secret" -}}
{{- end -}}
{{- if and $v.externalSecrets.enabled (ne $v.secrets.mode "existing") -}}
{{- fail "externalSecrets makes the Secrets: secrets.mode existing" -}}
{{- end -}}
{{- end -}}

{{/* The console's public address, as the control-plane chart works it out
     (stratum-cp.publicUrl): console.publicUrl, else from global. */}}
{{- define "stratum.consoleUrl" -}}
{{- $cp := index .Values "control-plane" -}}
{{- $set := (($cp.console | default dict).publicUrl) -}}
{{- $host := include "stratum.host" (dict "key" "console" "prefix" "consola" "root" .) -}}
{{- if $set -}}
{{- $set -}}
{{- else if $host -}}
{{- printf "%s://%s" .Values.global.scheme $host -}}
{{- end -}}
{{- end -}}
