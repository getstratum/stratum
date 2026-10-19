{{- define "stratum-cp.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "stratum-cp.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "stratum-cp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "stratum-cp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "stratum-cp.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "stratum-cp.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/part-of: stratum
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: control-plane
{{- end -}}

{{- define "stratum-cp.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "stratum-cp.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* repository:tag, or repository@digest when a digest is given. */}}
{{- define "stratum-cp.imageRef" -}}
{{- $img := index . 0 -}}
{{- $root := index . 1 -}}
{{- if $img.digest -}}
{{- printf "%s@%s" $img.repository $img.digest -}}
{{- else -}}
{{- printf "%s:%s" $img.repository (default $root.Chart.AppVersion $img.tag) -}}
{{- end -}}
{{- end -}}

{{/* Values the control plane would otherwise reject, or misuse, at run time. */}}
{{- define "stratum-cp.validate" -}}
{{- if not .Values.existingSecret -}}
{{- fail "existingSecret is required (DATABASE_URL, STRATUM_ENCRYPTION_KEY)" -}}
{{- end -}}
{{- if lt (int .Values.replicaCount) 2 -}}
{{- fail "replicaCount must be at least 2 for a highly available deployment" -}}
{{- end -}}
{{- if and .Values.autoscaling.enabled (lt (int .Values.autoscaling.minReplicas) 2) -}}
{{- fail "autoscaling.minReplicas must be at least 2" -}}
{{- end -}}
{{- if lt (int .Values.console.trustedProxyHops) 1 -}}
{{- fail "console.trustedProxyHops must be 1 or more" -}}
{{- end -}}
{{- $feed := toString .Values.console.modelCatalogUrl -}}
{{- if and $feed (ne $feed "off") (not (hasPrefix "https://" $feed)) -}}
{{- fail "console.modelCatalogUrl must be empty, \"off\" or an https:// URL" -}}
{{- end -}}
{{- range .Values.sidecars -}}
{{- if ne (toString (index . "restartPolicy")) "Always" -}}
{{- fail (printf "sidecars: %s needs restartPolicy: Always (a native sidecar)" (toString (index . "name"))) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "stratum-cp.podSecurityContext" -}}
runAsNonRoot: true
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "stratum-cp.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end -}}
