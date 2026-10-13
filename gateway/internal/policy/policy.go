// Package policy decides whether a team may send a request to a given
// provider and model. It works only on snapshot data and fails closed: a
// team without a policy gets nothing.
package policy

import (
	"fmt"
	"net/http"

	"github.com/getstratum/stratum/gateway/internal/snapshot"
)

// Violation is a rejected request, ready to be turned into an HTTP error.
type Violation struct {
	Status  int
	Code    string
	Message string
}

func (v *Violation) Error() string { return v.Message }

// Check validates provider and model against the team's policy.
// model may be bare ("gpt-4o"); an allowlist entry matches either the bare
// name or the qualified "provider/model" form.
func Check(pol snapshot.Policy, found bool, provider, model string) *Violation {
	if !found {
		return &Violation{http.StatusForbidden, "no_policy", "no policy is assigned to this team"}
	}
	if pol.Revoked {
		return &Violation{http.StatusForbidden, "team_disabled", "this team is disabled"}
	}
	if len(pol.AllowedProviders) > 0 {
		if _, ok := pol.AllowedProviders[provider]; !ok {
			return &Violation{http.StatusForbidden, "provider_not_allowed",
				fmt.Sprintf("provider %q is not allowed for this team", provider)}
		}
	}
	if model == "" {
		return &Violation{http.StatusBadRequest, "missing_model", "request body has no model"}
	}
	if !pol.AllowAllModels {
		_, bare := pol.AllowedModels[model]
		_, qualified := pol.AllowedModels[provider+"/"+model]
		if !bare && !qualified {
			return &Violation{http.StatusForbidden, "model_not_allowed",
				fmt.Sprintf("model %q is not allowed for this team", model)}
		}
	}
	return nil
}
