package main

import (
	"errors"
	"fmt"
	"main/models"
	"net/http"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func apiAuthLogin(ctx *ApiCtx) map[string]any {
	out := ctx.Out
	d := ctx.D

	login := d["login"]
	password := d["password"]

	if login == "" || password == "" {
		out["status"] = "Login and password are required!"
		return out
	}

	var u models.User
	if err := db.Where("login = ?", login).First(&u).Error; err != nil {
		out["status"] = "Login does not exists!"
		return out
	}

	if u.Status == 0 {
		out["status"] = "Login not confirmed!"
		return out
	}

	if err := checkPassword(u.Password, password); err != nil {
		out["status"] = "Password is invalid"
		return out
	}

	uid := strings.TrimSpace(d["uid"])

	if uid == "" {
		out["status"] = "Device UID is required"
		return out
	}

	access, _, err := issueAccess(&u)
	if err != nil {
		out["status"] = "failed to issue access token"
		return out
	}

	_ = db.Model(&models.User{}).
		Where("id = ?", u.ID).
		Update("last_active", time.Now()).
		Error

	out["access_token"] = access
	out["user"] = map[string]any{
		"status": u.Status,
	}

	var refreshToken string
	var userMaxDev uint

	err = db.Transaction(func(tx *gorm.DB) error {
		// Блокируем строку пользователя.
		var lockedUser models.User

		if err := tx.Clauses(
			clause.Locking{Strength: "UPDATE"},
		).First(&lockedUser, u.ID).Error; err != nil {
			return err
		}

		userMaxDev = userDeviceLimit(lockedUser.MaxDev)

		// Проверяем лимит и освобождаем старую
		// сессию текущего устройства.
		if err := prepareUserDeviceSession(
			tx, &lockedUser, uid,
		); err != nil {
			return err
		}

		refresh, jti, err := issueRefresh(
			&lockedUser, ctx.UA, refreshTTL,
		)
		if err != nil {
			return err
		}

		if err := tx.Create(&models.UserRefreshToken{
			UserID:    u.ID,
			UID:       uid,
			JTI:       jti,
			ExpiresAt: time.Now().Add(refreshTTL),
			UserAgent: ctx.UA,
			IP:        ctx.IP,
		}).Error; err != nil {
			return err
		}

		refreshToken = refresh
		return nil
	})

	if errors.Is(err, ErrMaxUserDevices) {
		out["status"] = "MAX_DEVICES"
		out["message"] = fmt.Sprintf(
			"Разрешено не более %d устройств",
			userMaxDev,
		)
		return out
	}

	if err != nil {
		out["status"] = "AUTH_ERROR"
		return out
	}

	out["refresh_token"] = refreshToken

	return out
}

func apiAuthRefresh(ctx *ApiCtx) map[string]any {
	out := ctx.Out
	d := ctx.D

	db.Where("expires_at < ?", time.Now()).Delete(&models.UserRefreshToken{})

	rt := d["refresh_token"]
	if rt == "" {
		out["status"] = "refresh token is empty"
		return out
	}

	claims, err := parseRefreshToken(rt)
	if err != nil {
		out["status"] = "invalid refresh token"
		return out
	}

	var row models.UserRefreshToken
	if err := db.Where("jti = ? AND user_id = ?", claims.ID, claims.UserID).First(&row).Error; err != nil {
		out["status"] = "refresh revoked"
		return out
	}

	if time.Now().After(row.ExpiresAt) {
		_ = db.Delete(&row).Error
		out["status"] = "refresh expired"
		return out
	}

	var u models.User
	if err := db.First(&u, claims.UserID).Error; err != nil {
		out["status"] = "user not found"
		return out
	}

	access, _, err := issueAccess(&u)
	if err != nil {
		out["status"] = "failed to issue access token"
		return out
	}

	out["access_token"] = access
	return out
}

func apiAuthLogout(ctx *ApiCtx) map[string]any {
	out := ctx.Out
	d := ctx.D

	rt := d["refresh_token"]
	if rt == "" {
		out["status"] = "OK"
		return out
	}

	if claims, err := parseToken(rt); err == nil {
		_ = db.Where("jti = ? AND user_id = ?", claims.ID, claims.UserID).
			Delete(&models.UserRefreshToken{}).
			Error
	}

	out["status"] = "OK"
	return out
}

func apiAuthMe(ctx *ApiCtx) map[string]any {
	out := ctx.Out

	user, err := getAuthUser(ctx.R)
	if err != nil {
		ctx.W.WriteHeader(http.StatusUnauthorized)
		out["status"] = "unauthorized"
		return out
	}

	out["status"] = "OK"
	out["user"] = map[string]any{
		"login":  user.Login,
		"status": user.Status,
	}

	return out
}

func apiAuthNewPassword(ctx *ApiCtx) map[string]any {
	out := ctx.Out
	d := ctx.D

	token := d["token"]
	newPass := d["password"]

	var u models.User
	if err := db.Where(
		"token = ? AND status > 0 AND updated_at > ?",
		token,
		time.Now().Add(-5*time.Minute),
	).First(&u).Error; err != nil {
		out["status"] = "Неверный или истекший токен!"
		return out
	}

	hashed, _ := hashPassword(newPass)

	if err := db.Model(&models.User{}).
		Where("id = ?", u.ID).
		Updates(map[string]any{
			"password": hashed,
			"token":    "",
		}).Error; err != nil {
		out["status"] = err.Error()
		return out
	}

	out["status"] = "OK"
	return out
}

func apiAuthRegister(ctx *ApiCtx) map[string]any {
	out := ctx.Out
	d := ctx.D

	var u models.User
	if err := db.Select("id,login").Where("login = ?", d["login"]).First(&u).Error; err == nil {
		out["status"] = "Такой аккаунт уже существует!"
		return out
	}

	if len(d["password"]) < 6 {
		out["status"] = "Недопустимый пароль (менее 6 символов)!"
		return out
	}

	token := md5hash(fmt.Sprintf("%d", time.Now().UnixNano()))

	if err := makeUser(d["login"], d["password"]); err != nil {
		out["status"] = err.Error()
		return out
	}

	if err := db.Model(&models.User{}).
		Where("login = ?", d["login"]).
		Update("token", token).Error; err != nil {
		out["status"] = err.Error()
		return out
	}

	out["status"] = "OK"
	out["token"] = token
	return out
}

func apiAuthConfirm(ctx *ApiCtx) map[string]any {
	out := ctx.Out
	d := ctx.D

	if err := db.Model(&models.User{}).
		Where(
			"token = ? AND status = 0 AND updated_at > ?",
			d["token"],
			time.Now().Add(-5*time.Minute),
		).
		Updates(map[string]any{
			"status": 1,
			"token":  "",
		}).Error; err != nil {
		out["status"] = "Неверный или истекший токен!"
		return out
	}

	out["status"] = "OK"
	return out
}

// userSessionAllowed проверяет, входит ли устройство
// в число разрешённых действующих сессий.
//
// При уменьшении лимита приоритет у устройств,
// чьи refresh-сессии были созданы раньше.
func userSessionAllowed(
	tx *gorm.DB,
	user *models.User,
	uid string,
) (bool, error) {
	limit := userDeviceLimit(user.MaxDev)

	var sessions []models.UserRefreshToken

	err := tx.
		Where(
			"user_id = ? AND expires_at > ?",
			user.ID,
			time.Now(),
		).
		Order("id ASC").
		Find(&sessions).Error

	if err != nil {
		return false, err
	}

	seen := make(map[string]bool)
	var count uint

	for _, session := range sessions {
		if session.UID == "" || seen[session.UID] {
			continue
		}

		seen[session.UID] = true
		count++

		if session.UID == uid {
			return count <= limit, nil
		}

		if count >= limit {
			return false, nil
		}
	}

	return false, nil
}
