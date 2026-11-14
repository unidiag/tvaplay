package main

import (
	"encoding/json"
	"errors"
	"log"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"

	"main/models"

	"github.com/golang-jwt/jwt/v5"
)

const (
	tokenTypeHLS = "hls"
	hlsTokenTTL  = 24 * time.Hour
)

// Создаём JWT, предназначенный только для HLS.
// Обычный access JWT здесь не используется.
func issueHLSToken(user *models.User, authSessionID uint64) (string, error) {
	if user == nil || user.ID == 0 {
		return "", errors.New("invalid user")
	}

	jti, err := generateJTI()
	if err != nil {
		return "", err
	}

	now := time.Now()

	claims := &Claims{
		UserID:        user.ID,
		Status:        user.Status,
		Type:          tokenTypeHLS,
		AuthSessionID: authSessionID,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(
				now.Add(hlsTokenTTL),
			),
			ID: jti,
			Subject: strconv.FormatUint(
				uint64(user.ID), 10,
			),
		},
	}

	token := jwt.NewWithClaims(
		jwt.SigningMethodHS256,
		claims,
	)

	return token.SignedString(jwtSecret)
}

// Выдача HLS JWT через существующий Bearer.
//
// POST /api/hls/token
func serveHLSToken(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "Method not allowed",
			http.StatusMethodNotAllowed)
		return
	}

	// Для выпуска HLS-токена обязателен
	// действующий API access JWT.
	user, err := getAuthUser(r)
	if err != nil || user == nil {
		http.Error(w, "Unauthorized",
			http.StatusUnauthorized)
		return
	}

	// Получаем sid только из подписанного access JWT, не из запроса.
	parts := strings.Fields(r.Header.Get("Authorization"))
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		http.Error(w, "Missing access token", http.StatusUnauthorized)
		return
	}
	accessClaims, err := parseAccessToken(parts[1])
	if err != nil || accessClaims.UserID != user.ID {
		http.Error(w, "Invalid access token", http.StatusUnauthorized)
		return
	}

	// Новый JWT должен ссылаться на действительную refresh-сессию пользователя.
	// Старые access JWT без sid допускаются ради совместимости, но их
	// статистика останется без auth_session_id до обновления access JWT.
	authSessionID := accessClaims.AuthSessionID
	if authSessionID != 0 {
		var count int64
		if err := db.WithContext(r.Context()).Model(&models.UserRefreshToken{}).
			Where("id = ? AND user_id = ? AND expires_at > ?", authSessionID, user.ID, time.Now()).
			Count(&count).Error; err != nil || count != 1 {
			http.Error(w, "Session expired or revoked", http.StatusUnauthorized)
			return
		}
	}

	token, err := issueHLSToken(user, authSessionID)
	if err != nil {
		http.Error(w, "Token issue failed",
			http.StatusInternalServerError)
		return
	}

	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"token":      token,
		"expires_in": int(hlsTokenTTL.Seconds()),
	})
}

// Определяет право просмотра HLS.
//
// allowed:    разрешён ли полноценный LIVE.
// token:      действительный HLS JWT.
// homeDenied: конфликт домашнего IP либо ошибка
//
//	его проверки (fail closed).
func getHLSAccess(
	r *http.Request,
) (bool, string, bool) {

	token := strings.TrimSpace(
		r.URL.Query().Get("ht"),
	)

	if token == "" || len(token) > 4096 {
		return false, "", false
	}

	claims, err := parseToken(token)
	if err != nil || claims.Type != tokenTypeHLS {
		return false, "", false
	}

	// Получаем актуальный статус и баланс.
	var user models.User

	err = db.WithContext(r.Context()).
		Select("id", "status", "balance").
		First(&user, claims.UserID).Error

	if err != nil {
		return false, "", false
	}

	// Приостановленная подписка.
	if user.Status == 0 {
		return false, token, false
	}

	balance, ok := new(big.Rat).SetString(
		strings.TrimSpace(user.Balance),
	)

	if !ok || balance.Sign() <= 0 {
		return false, token, false
	}

	// Проверяем единый IP для просмотра.
	clientIP := getHLSClientIP(r)

	allowed, err := allowHomeIP(
		r.Context(),
		user.ID,
		clientIP,
	)

	if err != nil {
		log.Printf(
			"[HLS] home IP check failed user=%d: %v",
			user.ID, err,
		)

		// Ошибка проверки не должна открывать доступ.
		return false, "", true
	}

	if !allowed {
		// С другого IP уже ведётся просмотр.
		return false, "", true
	}

	return true, token, false
}
