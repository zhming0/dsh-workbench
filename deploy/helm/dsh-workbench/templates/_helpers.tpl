{{- /* Standard chart helpers, plus the install guard.

The chart owns the control plane only. The sandbox pool is a separate kustomize
base (`deploy/kubernetes/runner`), which cannot know a release name, so the
names its manifest reads are fixed: the tunnel Service `dsh-host-tunnel`, the
ConfigMap `dsh-runner-config`, and the Secret `dsh-registration-token`. That is
also why the release is pinned to `dsh-workbench`: one host per namespace owns
those names, and a second release would collide with the first.
*/}}

{{- define "dsh-workbench.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "dsh-workbench.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := include "dsh-workbench.name" . }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "dsh-workbench.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* The label the pool's NetworkPolicy selects to allow the
tunnel: the host pod must carry exactly this, so it is fixed rather than
derived from the chart name. */}}
{{- define "dsh-workbench.selectorLabels" -}}
app.kubernetes.io/name: dsh-host
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "dsh-workbench.labels" -}}
helm.sh/chart: {{ include "dsh-workbench.chart" . }}
{{ include "dsh-workbench.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* The in-cluster tunnel address sandbox runners dial. Overridable for an
unusual namespace layout, but the default is what the shared runner manifest
expects. */}}
{{- define "dsh-workbench.tunnelUrl" -}}
{{- .Values.runner.hostUrl | default (printf "ws://dsh-host-tunnel.%s.svc.cluster.local:8081/tunnel" .Release.Namespace) }}
{{- end }}

{{/* Name of the Secret holding the shared registration token, read by the
pool's SandboxTemplate as well as the host. Fixed for the same reason
the tunnel Service is. */}}
{{- define "dsh-workbench.registrationTokenSecret" -}}
{{- .Values.registrationToken.existingSecret | default "dsh-registration-token" }}
{{- end }}

{{/* The home-level patch layer the chart owns: exactly the sandbox-manager
row, stated in full, because dsh applies an id-targeted patch by replacing the
row's whole config. Rendered into a ConfigMap mounted at
/data/.dsh/cordis.patch.yml.

A Kubernetes profile that names no namespace is rendered with the release
namespace: the provider's own default for that field is the fixed name
`dsh-sandbox`, which points at the wrong namespace wherever else the chart is
installed. */}}
{{- define "dsh-workbench.providerSettingsPatch" -}}
{{- $managed := deepCopy .Values.provider.sandboxManager -}}
{{- with $managed.profiles -}}
{{- range $name, $profile := . -}}
{{- if and (eq $profile.backend "kas") (not $profile.namespace) -}}
{{- $_ := set $profile "namespace" $.Release.Namespace -}}
{{- end -}}
{{- end -}}
{{- end -}}
- id: sandbox-manager
  config:
{{ toYaml $managed | indent 4 }}
{{- end }}

{{/* Fails the render on combinations that cannot work, so `helm install`
cannot produce a host that never becomes Ready. */}}
{{- define "dsh-workbench.validate" -}}
{{- $root := . -}}
{{- if ne .Release.Name "dsh-workbench" -}}
{{- fail (printf "install this chart as release `dsh-workbench`: the sandbox pool reads the fixed names dsh-host-tunnel, dsh-runner-config, and dsh-registration-token, which this release owns. Got %q." .Release.Name) }}
{{- end -}}
{{- $managed := .Values.provider.sandboxManager }}
{{- if and $managed (not $managed.profiles) -}}
{{- fail "provider.sandboxManager needs at least one profile; the provider rejects an empty profile map at runtime." }}
{{- end -}}
{{- if and $managed $managed.profiles -}}
{{- /* The pool manifests own the warm pools, so the chart cannot check that a
pool exists; what it can check is that a Kubernetes profile targets the
namespace its own Role and tunnel Service live in. */}}
{{- range $name, $profile := $managed.profiles }}
{{- if eq $profile.backend "kas" }}
{{- $ns := $profile.namespace | default $root.Release.Namespace }}
{{- if ne $ns $root.Release.Namespace -}}
{{- fail (printf "provider.sandboxManager.profiles.%s targets namespace %q but the chart installs into %q; Kubernetes profiles must target the release namespace, where the host's Role and the tunnel Service live." $name $ns $root.Release.Namespace) }}
{{- end }}
{{- end }}
{{- end }}
{{- end -}}
{{- if and .Values.registrationToken.existingSecret .Values.registrationToken.value -}}
{{- fail "registrationToken.existingSecret and registrationToken.value are mutually exclusive." }}
{{- end -}}
{{- if and .Values.oidc.enabled (not .Values.oidc.hostname) -}}
{{- fail "oidc.hostname is required when oidc.enabled is true: it is handed to dsh as --trusted-host and used in the proxy redirect URL." }}
{{- end -}}
{{- if and (ne .Values.service.type "ClusterIP") (not .Values.oidc.enabled) -}}
{{- fail "service.type only exposes the oauth2-proxy, and dsh itself binds pod loopback, so there is nothing to expose while oidc.enabled is false. Enable oidc or keep service.type ClusterIP." }}
{{- end -}}
{{- end -}}
