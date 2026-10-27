package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"main/models"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

// ============================================================
// USER ACTIVITY
// ============================================================

// uid -> время последнего запланированного обновления.
var lastActivePing sync.Map

// Обновляем активность пользователя не чаще одного раза в минуту.
const activityMinInterval = time.Minute

var activityMu sync.Mutex

func markUserActive(uid uint, ip, ua string) {
	if uid == 0 {
		return
	}

	now := time.Now()

	activityMu.Lock()

	if v, ok := lastActivePing.Load(uid); ok {
		if last, ok := v.(time.Time); ok {
			if now.Sub(last) < activityMinInterval {
				activityMu.Unlock()
				return
			}
		}
	}

	// Резервируем интервал до запуска goroutine.
	lastActivePing.Store(uid, now)

	activityMu.Unlock()

	go func(u uint, t time.Time, ip, ua string) {
		err := db.Model(&models.User{}).
			Where("id = ?", u).
			Updates(map[string]any{
				"last_active": t,
				"last_ip":     ip,
				"last_ua":     ua,
			}).Error

		if err != nil {
			// При ошибке следующему запросу разрешаем
			// повторить обновление.
			activityMu.Lock()

			if v, ok := lastActivePing.Load(u); ok {
				if last, ok := v.(time.Time); ok && last.Equal(t) {
					lastActivePing.Delete(u)
				}
			}

			activityMu.Unlock()
		}
	}(uid, now, ip, ua)
}

// ============================================================
// PASSWORDS
// ============================================================

func hashPassword(pw string) (string, error) {
	b, err := bcrypt.GenerateFromPassword(
		[]byte(pw),
		bcrypt.DefaultCost,
	)
	if err != nil {
		return "", err
	}

	return string(b), nil
}

func checkPassword(hash, pw string) error {
	return bcrypt.CompareHashAndPassword(
		[]byte(hash),
		[]byte(pw),
	)
}

// ============================================================
// JWT CLAIMS
// ============================================================

const (
	tokenTypeAccess  = "access"
	tokenTypeRefresh = "refresh"
)

type Claims struct {
	UserID uint   `json:"uid"`
	Status uint   `json:"status"`
	Type   string `json:"type"`

	jwt.RegisteredClaims
}

// ============================================================
// JWT ID
// ============================================================

// Генерируем криптографически случайный JTI.
// 16 байт = 128 бит случайности.
func generateJTI() (string, error) {
	b := make([]byte, 16)

	if _, err := rand.Read(b); err != nil {
		return "", err
	}

	return hex.EncodeToString(b), nil
}

// ============================================================
// ACCESS TOKEN
// ============================================================

// Короткоживущий JWT для API.
// Возвращает: token, jti, error.
func issueAccess(u *models.User) (string, string, error) {
	if u == nil || u.ID == 0 {
		return "", "", errors.New("invalid user")
	}

	jti, err := generateJTI()
	if err != nil {
		return "", "", err
	}

	now := time.Now()

	claims := &Claims{
		UserID: u.ID,
		Status: u.Status,
		Type:   tokenTypeAccess,

		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt: jwt.NewNumericDate(now),

			ExpiresAt: jwt.NewNumericDate(
				now.Add(accessTTL),
			),

			ID:      jti,
			Subject: strconv.FormatUint(uint64(u.ID), 10),
		},
	}

	token := jwt.NewWithClaims(
		jwt.SigningMethodHS256,
		claims,
	)

	signed, err := token.SignedString(jwtSecret)
	if err != nil {
		return "", "", err
	}

	return signed, jti, nil
}

// ============================================================
// REFRESH TOKEN
// ============================================================

// Долгоживущий JWT для обновления access-токена.
// userAgent сохранён в сигнатуре для совместимости
// с существующими вызовами проекта.
//
// Привязка refresh-сессии к userAgent выполняется
// при сохранении и проверке записи UserRefreshToken.
func issueRefresh(
	u *models.User,
	userAgent string,
	ttl time.Duration,
) (string, string, error) {
	if u == nil || u.ID == 0 {
		return "", "", errors.New("invalid user")
	}

	if ttl <= 0 {
		return "", "", errors.New("invalid refresh ttl")
	}

	jti, err := generateJTI()
	if err != nil {
		return "", "", err
	}

	now := time.Now()

	claims := &Claims{
		UserID: u.ID,
		Status: u.Status,
		Type:   tokenTypeRefresh,

		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt: jwt.NewNumericDate(now),

			ExpiresAt: jwt.NewNumericDate(
				now.Add(ttl),
			),

			ID:      jti,
			Subject: strconv.FormatUint(uint64(u.ID), 10),
		},
	}

	token := jwt.NewWithClaims(
		jwt.SigningMethodHS256,
		claims,
	)

	signed, err := token.SignedString(jwtSecret)
	if err != nil {
		return "", "", err
	}

	return signed, jti, nil
}

// ============================================================
// PARSE JWT
// ============================================================

// Проверяет подпись, срок действия и обязательные claims.
//
// Эта функция поддерживает оба типа JWT.
// Ограничение по типу выполняется отдельно:
//   - parseAccessToken()
//   - parseRefreshToken()
func parseToken(s string) (*Claims, error) {
	s = strings.TrimSpace(s)

	if s == "" {
		return nil, errors.New("empty token")
	}

	token, err := jwt.ParseWithClaims(
		s,
		&Claims{},
		func(t *jwt.Token) (interface{}, error) {
			return jwtSecret, nil
		},
		jwt.WithValidMethods(
			[]string{jwt.SigningMethodHS256.Name},
		),
		jwt.WithExpirationRequired(),
	)

	if err != nil {
		return nil, err
	}

	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, errors.New("invalid token")
	}

	if claims.UserID == 0 {
		return nil, errors.New("invalid token user id")
	}

	if claims.Subject != strconv.FormatUint(
		uint64(claims.UserID),
		10,
	) {
		return nil, errors.New("token subject mismatch")
	}

	if claims.ID == "" {
		return nil, errors.New("missing token jti")
	}

	if claims.IssuedAt == nil {
		return nil, errors.New("missing issued at")
	}

	return claims, nil
}

// ============================================================
// PARSE ACCESS TOKEN
// ============================================================

func parseAccessToken(s string) (*Claims, error) {
	claims, err := parseToken(s)
	if err != nil {
		return nil, err
	}

	if claims.Type != tokenTypeAccess {
		return nil, errors.New("invalid access token type")
	}

	return claims, nil
}

// ============================================================
// PARSE REFRESH TOKEN
// ============================================================

func parseRefreshToken(s string) (*Claims, error) {
	claims, err := parseToken(s)
	if err != nil {
		return nil, err
	}

	if claims.Type != tokenTypeRefresh {
		return nil, errors.New("invalid refresh token type")
	}

	return claims, nil
}

// ============================================================
// AUTH USER
// ============================================================

// Извлекает пользователя из Authorization: Bearer <JWT>.
//
// Важно: для доступа к API разрешён только access JWT.
func getAuthUser(r *http.Request) (*models.User, error) {
	if r == nil {
		return nil, errors.New("nil request")
	}

	auth := strings.TrimSpace(
		r.Header.Get("Authorization"),
	)

	parts := strings.Fields(auth)

	if len(parts) != 2 ||
		!strings.EqualFold(parts[0], "Bearer") {
		return nil, errors.New("no bearer token")
	}

	claims, err := parseAccessToken(parts[1])
	if err != nil {
		return nil, err
	}

	var user models.User

	if err := db.First(
		&user,
		claims.UserID,
	).Error; err != nil {
		return nil, errors.New("user not found")
	}

	// Активность обновляется асинхронно.
	markUserActive(
		user.ID,
		getClientIP(r),
		getClientAgent(r),
	)

	return &user, nil
}

// ============================================================
// CREATE USER
// ============================================================

func makeUser(login, password string) error {
	var count int64

	if err := db.Model(&models.User{}).
		Where("login = ?", login).
		Count(&count).Error; err != nil {
		return err
	}

	if count > 0 {
		return errors.New(
			"User login: " + login + " exists!",
		)
	}

	hash, err := hashPassword(password)
	if err != nil {
		return err
	}

	return db.Create(&models.User{
		Login:    login,
		Password: hash,
		Status:   0,
	}).Error
}
