package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"main/models"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	smsCooldown     = 2 * time.Minute
	smsCodeLifetime = 5 * time.Minute
	smsMaxAttempts  = 5
)

var confirmCodeRegexp = regexp.MustCompile(`^[0-9]{4}$`)

var (
	phoneRegexp = regexp.MustCompile(
		`^80(25|29|33|44)[0-9]{7}$`,
	)

	smsCodeRegexp = regexp.MustCompile(`^[0-9]{4}$`)

	smsHTTPClient = &http.Client{
		Timeout: 10 * time.Second,
	}

	// Сериализуем запросы по одному телефонному номеру.
	smsPhoneLocks sync.Map
)

type smsGatewayResponse struct {
	OK    bool   `json:"ok"`
	Code  string `json:"code"`
	Error string `json:"error"`
}

func smsError(
	ctx *ApiCtx,
	status string,
	message string,
) map[string]any {
	ctx.Out["status"] = status
	ctx.Out["message"] = message
	return ctx.Out
}

func getSMSPhoneLock(phone string) *sync.Mutex {
	lock, _ := smsPhoneLocks.LoadOrStore(
		phone,
		&sync.Mutex{},
	)

	return lock.(*sync.Mutex)
}

// Отправка запроса на внешний SMS-шлюз.
func sendSMS(phone string) (string, error) {
	form := url.Values{}
	form.Set("code", phone)

	req, err := http.NewRequest(
		http.MethodPost,
		SMSGATE,
		strings.NewReader(form.Encode()),
	)
	if err != nil {
		return "", fmt.Errorf("create request: %w", err)
	}

	req.Header.Set(
		"Content-Type",
		"application/x-www-form-urlencoded",
	)

	req.Header.Set("Accept", "application/json")

	resp, err := smsHTTPClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("gateway request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf(
			"gateway HTTP status: %d",
			resp.StatusCode,
		)
	}

	var result smsGatewayResponse

	decoder := json.NewDecoder(
		io.LimitReader(resp.Body, 4096),
	)

	if err := decoder.Decode(&result); err != nil {
		return "", fmt.Errorf(
			"invalid gateway JSON: %w",
			err,
		)
	}

	if !result.OK {
		return "", fmt.Errorf(
			"gateway rejected request: %s",
			result.Error,
		)
	}

	if !smsCodeRegexp.MatchString(result.Code) {
		return "", fmt.Errorf(
			"gateway returned invalid SMS code",
		)
	}

	return result.Code, nil
}

// checkUserDeviceLimit проверяет, разрешено ли устройству
// начать авторизацию.
//
// Функция только читает БД.
// Сессии не создаёт и не удаляет.
func checkUserDeviceLimit(
	user *models.User,
	uid string,
) (bool, error) {
	uid = strings.TrimSpace(uid)

	if uid == "" || len(uid) > 36 {
		return false, errors.New("invalid device UID")
	}

	now := time.Now()

	// Проверяем наличие действующей сессии
	// именно у этого устройства.
	var existing int64

	err := db.Model(&models.UserRefreshToken{}).
		Where(
			"user_id = ? AND uid = ? AND expires_at > ?",
			user.ID, uid, now,
		).
		Count(&existing).Error

	if err != nil {
		return false, err
	}

	// Устройство уже авторизовано.
	// Повторный вход не занимает новый слот.
	if existing > 0 {
		return true, nil
	}

	// Подсчитываем уникальные активные устройства.
	var devices int64

	err = db.Model(&models.UserRefreshToken{}).
		Where(
			"user_id = ? AND expires_at > ? AND uid <> ''",
			user.ID, now,
		).
		Distinct("uid").
		Count(&devices).Error

	if err != nil {
		return false, err
	}

	// Учитываем наличие лицензии.
	limit := userDeviceLimit(user.MaxDev)

	return devices < int64(limit), nil
}

// API: guestSendcode
func apiGuestSendcode(ctx *ApiCtx) map[string]any {

	// Проверяем разрешённый IP до любых
	// операций с пользователем и SMS.
	if !isAllowedTVRequest(ctx.R) {
		return smsError(
			ctx,
			"GEO_BLOCKED",
			"Доступ запрещён по геопозиции",
		)
	}

	phone := strings.TrimSpace(ctx.D["phone"])

	// 1. Проверяем телефон.
	if !phoneRegexp.MatchString(phone) {
		return smsError(
			ctx,
			"INVALID_PHONE",
			"Некорректный номер телефона",
		)
	}

	// Защита от параллельной отправки на один телефон.
	lock := getSMSPhoneLock(phone)
	lock.Lock()
	defer lock.Unlock()

	// 2. Ищем пользователя.
	var user models.User

	result := db.Where(
		"login = ?", phone,
	).First(&user)

	if result.Error != nil {
		if result.Error != gorm.ErrRecordNotFound {
			log.Printf(
				"[guestSendcode] DB lookup error: %v",
				result.Error,
			)

			return smsError(
				ctx,
				"DB_ERROR",
				"Ошибка базы данных",
			)
		}

		// 3. Новый номер — создаём пользователя.
		password, err := hashPassword(USERPASSWORD)
		if err != nil {
			log.Printf(
				"[guestSendcode] password hash error: %v",
				err,
			)

			return smsError(
				ctx,
				"INTERNAL_ERROR",
				"Внутренняя ошибка сервера",
			)
		}

		user = models.User{
			Login:    phone,
			Password: password,
			Status:   0,
		}

		if err := db.Create(&user).Error; err != nil {
			log.Printf(
				"[guestSendcode] user create error: %v",
				err,
			)

			return smsError(
				ctx,
				"DB_ERROR",
				"Ошибка создания пользователя",
			)
		}
	}

	// Проверяем лимит устройств до отправки SMS.
	uid := strings.TrimSpace(ctx.D["uid"])

	if uid == "" || len(uid) > 36 {
		return smsError(
			ctx,
			"INVALID_UID",
			"Некорректный UID устройства",
		)
	}

	allowed, err := checkUserDeviceLimit(&user, uid)

	if err != nil {
		log.Printf(
			"[guestSendcode] device limit check error: %v",
			err,
		)

		return smsError(
			ctx,
			"DB_ERROR",
			"Ошибка проверки лимита устройств",
		)
	}

	if !allowed {
		limit := userDeviceLimit(user.MaxDev)

		return smsError(
			ctx,
			"MAX_DEVICES",
			fmt.Sprintf(
				"Достигнут лимит устройств (%d). "+
					"Выйдите из аккаунта на другом устройстве.",
				limit,
			),
		)
	}

	// 4. Проверяем интервал между SMS.
	now := time.Now()

	if user.LastCodeSentAt != nil {
		elapsed := now.Sub(*user.LastCodeSentAt)

		if elapsed < smsCooldown {
			remaining := int(
				(smsCooldown - elapsed + time.Second - 1) /
					time.Second,
			)

			ctx.Out["retry_after"] = remaining

			return smsError(
				ctx,
				"SMS_COOLDOWN",
				fmt.Sprintf(
					"Повторная отправка возможна через %d сек.",
					remaining,
				),
			)
		}
	}

	// 5. Отправляем запрос на SMS-шлюз.
	code, err := sendSMS(phone)

	if err != nil {
		log.Printf(
			"[guestSendcode] SMS gateway error: %v",
			err,
		)

		return smsError(
			ctx,
			"SMS_GATEWAY_ERROR",
			"Не удалось отправить SMS-код",
		)
	}

	// 6. SMS отправлена — сохраняем код и время.
	sentAt := time.Now()

	err = db.Model(&user).
		Updates(map[string]any{
			"last_code":         code,
			"last_code_sent_at": sentAt,
		}).Error

	if err != nil {
		log.Printf(
			"[guestSendcode] save SMS code error: %v",
			err,
		)

		return smsError(
			ctx,
			"DB_ERROR",
			"Не удалось сохранить SMS-код",
		)
	}

	// 7. Логируем успешную отправку без SMS-кода.
	log.Printf(
		"[guestSendcode] SMS sent user_id=%d phone=%s uid=%s ip=%s",
		user.ID,
		phone,
		ctx.D["uid"],
		ctx.IP,
	)

	ctx.Out["status"] = "OK"
	ctx.Out["message"] = "SMS-код отправлен"

	// Код клиенту не возвращаем.
	return ctx.Out
}

//  ██████╗ ██████╗ ███╗   ██╗███████╗██╗██████╗ ███╗   ███╗     ██████╗ ██████╗ ██████╗ ███████╗
// ██╔════╝██╔═══██╗████╗  ██║██╔════╝██║██╔══██╗████╗ ████║    ██╔════╝██╔═══██╗██╔══██╗██╔════╝
// ██║     ██║   ██║██╔██╗ ██║█████╗  ██║██████╔╝██╔████╔██║    ██║     ██║   ██║██║  ██║█████╗
// ██║     ██║   ██║██║╚██╗██║██╔══╝  ██║██╔══██╗██║╚██╔╝██║    ██║     ██║   ██║██║  ██║██╔══╝
// ╚██████╗╚██████╔╝██║ ╚████║██║     ██║██║  ██║██║ ╚═╝ ██║    ╚██████╗╚██████╔╝██████╔╝███████╗
//  ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝     ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝

func apiGuestConfirmcode(ctx *ApiCtx) map[string]any {
	phone := strings.TrimSpace(ctx.D["phone"])
	code := strings.TrimSpace(ctx.D["code"])
	uid := strings.TrimSpace(ctx.D["uid"])

	// Проверяем телефон.
	if !phoneRegexp.MatchString(phone) {
		return smsError(
			ctx,
			"INVALID_PHONE",
			"Некорректный номер телефона",
		)
	}

	// Проверяем формат SMS-кода.
	if !confirmCodeRegexp.MatchString(code) {
		return smsError(
			ctx,
			"INVALID_CODE",
			"Некорректный SMS-код",
		)
	}

	// UID устройства обязателен.
	if uid == "" || len(uid) > 36 {
		return smsError(
			ctx,
			"INVALID_UID",
			"Некорректный UID устройства",
		)
	}

	var accessToken string
	var refreshToken string
	var userStatus uint
	var userMaxDev uint

	status := "OK"
	message := ""

	err := db.Transaction(func(tx *gorm.DB) error {
		var user models.User

		// Блокируем пользователя на время проверки.
		result := tx.Clauses(
			clause.Locking{Strength: "UPDATE"},
		).
			Where("login = ?", phone).
			First(&user)

		if errors.Is(result.Error, gorm.ErrRecordNotFound) {
			status = "INVALID_CODE"
			message = "Неверный SMS-код"
			return nil
		}

		if result.Error != nil {
			return result.Error
		}

		userMaxDev = userDeviceLimit(user.MaxDev)

		// Код должен существовать.
		if user.LastCode == "" ||
			user.LastCodeSentAt == nil {

			status = "CODE_EXPIRED"
			message = "Запросите новый SMS-код"
			return nil
		}

		// Проверяем срок действия.
		now := time.Now()

		if now.Sub(*user.LastCodeSentAt) > smsCodeLifetime {
			status = "CODE_EXPIRED"
			message = "Срок действия SMS-кода истёк"
			return nil
		}

		// Проверяем лимит попыток.
		if user.LastCodeAttempts >= smsMaxAttempts {
			status = "TOO_MANY_ATTEMPTS"
			message = "Превышено количество попыток"
			return nil
		}

		// Сравниваем код.
		valid := subtle.ConstantTimeCompare(
			[]byte(user.LastCode),
			[]byte(code),
		) == 1

		if !valid {
			attempts := user.LastCodeAttempts + 1

			updates := map[string]any{
				"last_code_attempts": attempts,
			}

			if attempts >= smsMaxAttempts {
				updates["last_code"] = ""
			}

			if err := tx.Model(&user).
				Updates(updates).Error; err != nil {
				return err
			}

			if attempts >= smsMaxAttempts {
				status = "TOO_MANY_ATTEMPTS"
				message = "Превышено количество попыток"
			} else {
				status = "INVALID_CODE"
				message = "Неверный SMS-код"
			}

			return nil
		}

		if err := prepareUserDeviceSession(
			tx,
			&user,
			uid,
		); err != nil {
			return err
		}

		// SMS-код подтверждён.
		// Генерируем короткоживущий access JWT.
		access, _, err := issueAccess(&user)
		if err != nil {
			return err
		}

		// Генерируем долгоживущий refresh JWT.
		refresh, jti, err := issueRefresh(
			&user,
			ctx.UA,
			refreshTTL,
		)
		if err != nil {
			return err
		}

		// Сохраняем refresh-сессию в БД.
		// Всё происходит в одной транзакции.
		if err := tx.Create(&models.UserRefreshToken{
			UserID:    user.ID,
			JTI:       jti,
			UID:       uid,
			ExpiresAt: time.Now().Add(refreshTTL),
			UserAgent: ctx.UA,
			IP:        ctx.IP,
		}).Error; err != nil {
			return err
		}

		// Обновляем информацию о пользователе.
		updates := map[string]any{
			"login_at":           now,
			"last_active":        now,
			"last_ip":            ctx.IP,
			"last_ua":            ctx.UA,
			"last_code":          "",
			"last_code_attempts": 0,
		}

		if err := tx.Model(&user).
			Updates(updates).Error; err != nil {
			return err
		}

		// Возвращаем токены после успешного завершения транзакции.
		accessToken = access
		refreshToken = refresh
		userStatus = user.Status

		return nil
	})

	if errors.Is(err, ErrMaxUserDevices) {
		return smsError(
			ctx,
			"MAX_DEVICES",
			fmt.Sprintf(
				"Лимит устройств: %d. "+
					"Выйдите из аккаунта на другом устройстве.",
				userMaxDev,
			),
		)
	}

	if err != nil {
		log.Printf("[guestConfirmcode] error: %v", err)

		return smsError(
			ctx,
			"AUTH_ERROR",
			"Не удалось выполнить авторизацию",
		)
	}

	if status != "OK" {
		return smsError(ctx, status, message)
	}

	log.Printf(
		"[guestConfirmcode] authorized phone=%s uid=%s ip=%s",
		phone,
		uid,
		ctx.IP,
	)

	ctx.Out["status"] = "OK"
	ctx.Out["access_token"] = accessToken
	ctx.Out["refresh_token"] = refreshToken
	ctx.Out["user"] = map[string]any{
		"status": userStatus,
	}

	return ctx.Out
}

// ██████╗ ███████╗██╗   ██╗██╗ ██████╗███████╗███████╗
// ██╔══██╗██╔════╝██║   ██║██║██╔════╝██╔════╝██╔════╝
// ██║  ██║█████╗  ██║   ██║██║██║     █████╗  ███████╗
// ██║  ██║██╔══╝  ╚██╗ ██╔╝██║██║     ██╔══╝  ╚════██║
// ██████╔╝███████╗ ╚████╔╝ ██║╚██████╗███████╗███████║
// ╚═════╝ ╚══════╝  ╚═══╝  ╚═╝ ╚═════╝╚══════╝╚══════╝

var ErrMaxUserDevices = errors.New("device limit reached")

// prepareUserDeviceSession проверяет лимит устройств
// и удаляет старые сессии текущего устройства.
//
// Вызывать только внутри транзакции, в которой
// строка пользователя заблокирована FOR UPDATE.
func prepareUserDeviceSession(
	tx *gorm.DB,
	user *models.User,
	uid string,
) error {
	uid = strings.TrimSpace(uid)

	if uid == "" || len(uid) > 36 {
		return errors.New("invalid device UID")
	}

	if user.MaxDev == 0 {
		return errors.New("invalid user device limit")
	}

	now := time.Now()

	// Удаляем истёкшие refresh-сессии пользователя
	if err := tx.
		Where(
			"user_id = ? AND expires_at <= ?",
			user.ID, now,
		).
		Delete(&models.UserRefreshToken{}).Error; err != nil {
		return err
	}

	// Проверяем, есть ли сессия текущего устройства
	var existing int64

	if err := tx.Model(&models.UserRefreshToken{}).
		Where(
			"user_id = ? AND uid = ? AND expires_at > ?",
			user.ID, uid, now,
		).
		Count(&existing).Error; err != nil {
		return err
	}

	// Если устройство новое, проверяем лимит
	if existing == 0 {
		var devices int64

		if err := tx.Model(&models.UserRefreshToken{}).
			Where(
				"user_id = ? AND expires_at > ? AND uid <> ''",
				user.ID, now,
			).
			Distinct("uid").
			Count(&devices).Error; err != nil {
			return err
		}

		if devices >= int64(userDeviceLimit(user.MaxDev)) {
			return ErrMaxUserDevices
		}
	}

	// Удаляем старые refresh-сессии текущего устройства
	return tx.
		Where("user_id = ? AND uid = ?", user.ID, uid).
		Delete(&models.UserRefreshToken{}).Error
}
