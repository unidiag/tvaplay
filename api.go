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

	"guestHandshake":   apiGuestHandshake,
	"guestSendcode":    apiGuestSendcode,
	"guestConfirmcode": apiGuestConfirmcode,

	// account
	"accountInfo":          apiAccountInfo,
	"accountDevices":       apiAccountDevices,
	"accountDeviceRevoke":  apiAccountDeviceRevoke,
	"accountPackageToggle": apiAccountPackageToggle,
	"accountPauseToggle":   apiAccountPauseToggle,
	"accountTransactions":  apiAccountTransactions,

	// auth
	"authLogin":       apiAuthLogin,
	"authRefresh":     apiAuthRefresh,
	"authLogout":      apiAuthLogout,
	"authMe":          apiAuthMe,
	"authNewPassword": apiAuthNewPassword,
	"authRegister":    apiAuthRegister,
	"authConfirm":     apiAuthConfirm,

	"guestPhoneConfig": apiGuestPhoneConfig, // получение регекса для формата номера телефона
	// EPG
	"getEPGNow": apiEPGNow,

	// Admin channels
	"adminChannels":                 apiAdminChannels,
	"adminChannelArchiveSizes":      apiAdminChannelArchiveSizes,
	"adminChannelSave":              apiAdminChannelSave,
	"adminChannelArchiveMoveStatus": apiAdminChannelArchiveMoveStatus,
	"adminChannelDelete":            apiAdminChannelDelete,
	"adminChannelsOrder":            apiAdminChannelsOrder,
	"adminEPGChannels":              apiAdminEPGChannels,

	// Admin settings
	"adminSettings":      apiAdminSettings,
	"adminSettingSave":   apiAdminSettingSave,
	"adminSettingDelete": apiAdminSettingDelete,
	// Admin packages
	"adminPackages":      apiAdminPackages,
	"adminPackageSave":   apiAdminPackageSave,
	"adminPackageDelete": apiAdminPackageDelete,
	// Admin users
	"adminUsers":                   apiAdminUsers,
	"adminUserSave":                apiAdminUserSave,
	"adminUserSessions":            apiAdminUserSessions,
	"adminUserSessionDelete":       apiAdminUserSessionDelete,
	"adminUserBalanceTransactions": apiAdminUserBalanceTransactions,
	// Admin storages
	"adminStorages":       apiAdminStorages,
	"adminStorageSave":    apiAdminStorageSave,
	"adminStorageDelete":  apiAdminStorageDelete,
	"adminStorageSmart":   apiAdminStorageSmart,
	"adminStorageIO":      apiAdminStorageIO,
	"adminStorageMetrics": apiAdminStorageMetrics,
	//Admin sessions
	"adminSessions":      apiAdminSessions,
	"adminSessionDelete": apiAdminSessionDelete,
	"adminViewStats":     apiAdminViewStats,
	// Admin statistics
	"adminStatistics":          apiAdminStatistics,
	"adminProgrammeStatistics": apiAdminProgrammeStatistics,
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

	if strings.HasPrefix(op, "admin") {
		if user == nil || user.Status < 8 {
			out["status"] = "FORBIDDEN"
			out["message"] = "Administrator access required"
			return out
		}

		// Системные настройки доступны только статусу 9.
		switch op {
		case "adminSettings",
			"adminSettingSave",
			"adminSettingDelete":

			if user.Status != 9 {
				out["status"] = "FORBIDDEN"
				out["message"] = "Super administrator access required"
				return out
			}
		}
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
