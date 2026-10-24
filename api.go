package main

import (
	"main/models"
	"net/http"
	"strings"

	"github.com/spf13/cast"
)

type ApiCtx struct {
	Data map[string]any
	D    map[string]string
	R    *http.Request
	W    http.ResponseWriter
	Out  map[string]any
	User *models.User
	IP   string
	UA   string
}

type APIFn func(*ApiCtx) map[string]any

var apiRoutes = map[string]APIFn{

	"guestHandshake": apiGuestHandshake,

	// auth
	"authLogin":       apiAuthLogin,
	"authRefresh":     apiAuthRefresh,
	"authLogout":      apiAuthLogout,
	"authMe":          apiAuthMe,
	"authNewPassword": apiAuthNewPassword,
	"authRegister":    apiAuthRegister,
	"authConfirm":     apiAuthConfirm,

	// main
	"getTime": apiGetTime,

	// EPG
	"guestEPGNow": apiGuestEPGNow,
}

func api(data map[string]any, r *http.Request, w http.ResponseWriter) map[string]any {

	out := map[string]any{
		"status": "OK",
	}

	ip := getClientIP(r)
	ua := getClientAgent(r)
	user, _ := getAuthUser(r)

	d := map[string]string{}
	for k, v := range data {
		if k == "op" {
			continue
		}

		vv := cast.ToString(v)
		switch vv {
		case "true":
			vv = "1"
		case "false":
			vv = "0"
		}
		d[k] = vv
	}

	op := strings.TrimSpace(cast.ToString(data["op"]))
	if op == "" {
		out["status"] = "Operation is empty"
		return out
	}

	// guests can access only auth API
	if user == nil && !strings.HasPrefix(op, "auth") && !strings.HasPrefix(op, "guest") {
		out["status"] = "Not authorize!"
		return out
	}

	fn, ok := apiRoutes[op]
	if !ok {
		out["response"] = "default value API"
		out["status"] = "NOK"
		return out
	}

	ctx := &ApiCtx{
		Data: data,
		D:    d,
		R:    r,
		W:    w,
		Out:  out,
		User: user,
		IP:   ip,
		UA:   ua,
	}

	return fn(ctx)
}
