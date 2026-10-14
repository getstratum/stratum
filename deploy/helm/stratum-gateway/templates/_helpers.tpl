{{- define "stratum-gateway.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "stratum-gateway.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "stratum-gateway.selectorLabels" -}}
app.kubernetes.io/name: {{ include "stratum-gateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "stratum-gateway.commonLabels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "stratum-gateway.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/part-of: stratum
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "stratum-gateway.labels" -}}
{{ include "stratum-gateway.commonLabels" . }}
app.kubernetes.io/component: data-plane
{{- end -}}

{{- define "stratum-gateway.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "stratum-gateway.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "stratum-gateway.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}
{{- end -}}

{{/* Validate values that the gateway would otherwise reject at startup. */}}
{{- define "stratum-gateway.validate" -}}
{{- if eq .Values.mode "controlPlane" -}}
{{- if not .Values.controlPlane.url -}}
{{- fail "controlPlane.url is required when mode=controlPlane" -}}
{{- end -}}
{{- if not .Values.existingSecret -}}
{{- fail "existingSecret is required when mode=controlPlane (STRATUM_SYNC_TOKEN, STRATUM_INSTANCE_ID, STRATUM_SNAPSHOT_KEY)" -}}
{{- end -}}
{{- else if eq .Values.mode "static" -}}
{{- if and (not .Values.static.config) (not .Values.static.existingConfigMap) -}}
{{- fail "static.config or static.existingConfigMap is required when mode=static" -}}
{{- end -}}
{{- else -}}
{{- fail "mode must be controlPlane or static" -}}
{{- end -}}
{{- if lt (int .Values.replicaCount) 2 -}}
{{- fail "replicaCount must be at least 2 for a highly available deployment (3 recommended)" -}}
{{- end -}}
{{- end -}}

{{- define "stratum-gateway.configMapName" -}}
{{- default (printf "%s-config" (include "stratum-gateway.fullname" .)) .Values.static.existingConfigMap -}}
{{- end -}}
