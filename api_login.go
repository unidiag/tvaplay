package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"main/models"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	smsCooldown      = 2 * time.Minute
	smsCodeLifetime  = 5 * time.Minute
	smsMaxAttempts   = 5
	smsScriptTimeout = 20 * time.Second
)

var (
	// Сериализуем запросы по одному телефонному номеру.
	smsPhoneLocks     sync.Map
	confirmCodeRegexp = regexp.MustCompile(`^[0-9]{4}$`)
)

type smsGatewayResponse struct {
	MessageID json.RawMessage `json:"message_id"`
	Code      int             `json:"code"`
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

const defaultPhoneRegex = `^\+[1-9][0-9]{7,14}$`

// phoneRegexPattern reads the current pattern from Settings.
func phoneRegexPattern() string {
	pattern := strings.TrimSpace(getSetting("phone_regex"))
	if pattern == "" {
		return defaultPhoneRegex
	}
	return pattern
}

// validatePhoneRegex checks the administrator's pattern.
func validatePhoneRegex(pattern string) error {
	if len(pattern) == 0 || len(pattern) > 128 {
		return errors.New("Phone regex must contain 1-128 characters")
	}

	if !strings.HasPrefix(pattern, "^") ||
		!strings.HasSuffix(pattern, "$") {
		return errors.New("Phone regex must be anchored with ^ and $")
	}

	_, err := regexp.Compile(pattern)
	if err != nil {
		return fmt.Errorf("Invalid phone regex: %w", err)
	}

	return nil
}

// isValidPhone verifies both the configured pattern
// and the international E.164 representation.
func isValidPhone(phone string) bool {
	if !regexp.MustCompile(defaultPhoneRegex).MatchString(phone) {
		return false
	}

	pattern := phoneRegexPattern()

	if err := validatePhoneRegex(pattern); err != nil {
		return false
	}

	re, err := regexp.Compile(pattern)
	return err == nil && re.MatchString(phone)
}

// apiGuestPhoneConfig returns only the public phone pattern.
func apiGuestPhoneConfig(ctx *ApiCtx) map[string]any {
	pattern := phoneRegexPattern()

	if err := validatePhoneRegex(pattern); err != nil {
		ctx.Out["status"] = "CONFIG_ERROR"
		ctx.Out["message"] = "Phone validation is not configured"
		return ctx.Out
	}

	ctx.Out["phone_regex"] = pattern

	return ctx.Out
}

// sendSMS выполняет локальный SMS-шлюз.
// Принимает номер телефона, возвращает отправленный
// четырёхзначный код либо ошибку.
func sendSMS(phone string) (string, error) {
	phone = strings.TrimSpace(phone)

	if !isValidPhone(phone) {
		return "", fmt.Errorf("invalid phone number")
	}

	ctx, cancel := context.WithTimeout(
		context.Background(),
		smsScriptTimeout,
	)
	defer cancel()

	// Скрипт самостоятельно удаляет из номера
	// все символы, кроме цифр.
	// Второй аргумент не передаём: режим SMS-кода.
	cmd := exec.CommandContext(
		ctx,
		getSetting("smsgate"),
		phone,
	)

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	output, err := cmd.Output()

	if ctx.Err() != nil {
		return "", fmt.Errorf(
			"SMS script timeout: %w",
			ctx.Err(),
		)
	}

	if err != nil {
		// Не передаём содержимое stdout/stderr клиенту:
		// ответ провайдера может содержать служебные данные.
		return "", fmt.Errorf(
			"SMS script execution failed: %w",
			err,
		)
	}

	if len(output) == 0 || len(output) > 4096 {
		return "", fmt.Errorf(
			"invalid SMS script response size",
		)
	}

	var response smsGatewayResponse

	if err := json.Unmarshal(output, &response); err != nil {
		return "", fmt.Errorf(
			"invalid SMS script JSON: %w",
			err,
		)
	}

	// Подтверждение принятия сообщения шлюзом.
	messageID := strings.TrimSpace(
		string(response.MessageID),
	)

	if messageID == "" ||
		messageID == "null" ||
		messageID == `""` {
		return "", fmt.Errorf(
			"SMS gateway returned no message_id",
		)
	}

	// Код должен быть числом 1000..9999.
	if response.Code < 1000 || response.Code > 9999 {
		return "", fmt.Errorf(
			"SMS gateway returned invalid code",
		)
	}

	code := strconv.Itoa(response.Code)

	return code, nil
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

func createSMSUser(phone, password string) (models.User, error) {
	var user models.User

	err := db.Connection(func(conn *gorm.DB) error {
		const lockName = "tvaplay_first_user"

		var locked int

		// Блокировка на одном MySQL-соединении.
		if err := conn.Raw(
			"SELECT GET_LOCK(?, 10)",
			lockName,
		).Scan(&locked).Error; err != nil {
			return err
		}

		if locked != 1 {
			return errors.New("user registration lock timeout")
		}

		defer func() {
			_ = conn.Exec(
				"DO RELEASE_LOCK(?)",
				lockName,
			).Error
		}()

		return conn.Transaction(func(tx *gorm.DB) error {
			// Повторно проверяем существование номера,
			// поскольку другой запрос мог создать его раньше.
			err := tx.Where("login = ?", phone).
				First(&user).Error

			if err == nil {
				return nil
			}

			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}

			var count int64

			if err := tx.Model(&models.User{}).
				Count(&count).Error; err != nil {
				return err
			}

			status := uint(0)

			// Только самый первый пользователь.
			if count == 0 {
				status = 9
			}

			// Лимит устройств для новых пользователей.
			maxDev, err := strconv.Atoi(
				strings.TrimSpace(getSetting("max_dev_for_new")),
			)

			if err != nil || maxDev < 1 || maxDev > 1000 {
				maxDev = 1
			}

			// Первоначальный баланс нового абонента.
			// Настройка balance_for_new, например:
			// 15.00, 0.00 или -10.50.
			balance := strings.TrimSpace(
				getSetting("balance_for_new"),
			)

			if balance == "" {
				balance = "0.00"
			}

			// Проверяем формат DECIMAL(12,2):
			// максимум 10 цифр до точки и 2 после.
			balanceRegexp := regexp.MustCompile(
				`^-?(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$`,
			)

			if !balanceRegexp.MatchString(balance) {
				return fmt.Errorf(
					"invalid balance_for_new setting: %q",
					balance,
				)
			}

			user = models.User{
				Login:    phone,
				Password: password,
				Status:   status,
				MaxDev:   uint(maxDev),
				Balance:  balance,
			}

			if err := tx.Create(&user).Error; err != nil {
				return err
			}

			// Первоначальное начисление баланса новому абоненту.
			// Создаём финансовую операцию в той же транзакции.
			if balance != "0.00" && balance != "0" && balance != "0.0" {

				// Получаем фактически сохранённый баланс из MySQL.
				var balanceAfter struct {
					Value string `gorm:"column:balance"`
				}

				result := tx.Raw(
					"SELECT CAST(balance AS CHAR) AS balance "+
						"FROM users WHERE id = ?",
					user.ID,
				).Scan(&balanceAfter)

				if result.Error != nil {
					return result.Error
				}

				if result.RowsAffected != 1 ||
					strings.TrimSpace(balanceAfter.Value) == "" {
					return fmt.Errorf(
						"invalid initial balance: user_id=%d",
						user.ID,
					)
				}

				// Уникальный ключ первоначального начисления.
				operationKey := fmt.Sprintf(
					"initial:%d",
					user.ID,
				)

				ledger := models.BalanceTransaction{
					UserID:       user.ID,
					Type:         models.BalanceTopup,
					Amount:       balanceAfter.Value,
					BalanceAfter: &balanceAfter.Value,
					OperationKey: operationKey,
				}

				if err := tx.Create(&ledger).Error; err != nil {
					return fmt.Errorf(
						"save initial balance transaction user_id=%d: %w",
						user.ID,
						err,
					)
				}
			}

			// Назначаем стандартные пакеты новому абоненту.
			// Всё выполняется внутри одной транзакции.
			return assignForNewPackages(tx, user.ID)
		})
	})

	return user, err
}

// API: guestSendcode
func apiGuestSendcode(ctx *ApiCtx) map[string]any {

	phone := strings.TrimSpace(ctx.D["phone"])

	// 1. Проверяем телефон.
	if !isValidPhone(phone) {
		return smsError(
			ctx,
			"INVALID_PHONE",
			"Invalid phone number",
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
				"Database error",
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
				"Internal server error",
			)
		}

		user, err = createSMSUser(phone, password)

		if err != nil {
			log.Printf(
				"[guestSendcode] user create error: %v",
				err,
			)

			return smsError(
				ctx,
				"DB_ERROR",
				"Failed to create user",
			)
		}

		log.Printf(
			"[guestSendcode] user registered: id=%d status=%d",
			user.ID,
			user.Status,
		)
	}

	// Проверяем лимит устройств до отправки SMS.
	uid := strings.TrimSpace(ctx.D["uid"])

	if uid == "" || len(uid) > 36 {
		return smsError(
			ctx,
			"INVALID_UID",
			"Invalid device UID",
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
			"Failed to check device limit",
		)
	}

	if !allowed {
		limit := userDeviceLimit(user.MaxDev)

		return smsError(
			ctx,
			"MAX_DEVICES",
			fmt.Sprintf(
				"Device limit reached (%d). "+
					"Sign out on another device.",
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
					"You can request another SMS code in %d seconds.",
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
			"Failed to send SMS code",
		)
	}

	// 6. SMS отправлена — сохраняем код и время.
	sentAt := time.Now()

	err = db.Model(&user).
		Updates(map[string]any{
			"last_code":          code,
			"last_code_sent_at":  sentAt,
			"last_code_attempts": 0,
		}).Error

	if err != nil {
		log.Printf(
			"[guestSendcode] save SMS code error: %v",
			err,
		)

		return smsError(
			ctx,
			"DB_ERROR",
			"Failed to save SMS code",
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
	ctx.Out["message"] = "SMS code sent"

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
	if !isValidPhone(phone) {
		return smsError(
			ctx,
			"INVALID_PHONE",
			"Invalid phone number",
		)
	}

	// Проверяем формат SMS-кода.
	if !confirmCodeRegexp.MatchString(code) {
		return smsError(
			ctx,
			"INVALID_CODE",
			"Invalid SMS code",
		)
	}

	// UID устройства обязателен.
	if uid == "" || len(uid) > 36 {
		return smsError(
			ctx,
			"INVALID_UID",
			"Invalid device UID",
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
			message = "Incorrect SMS code"
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
			message = "Request a new SMS code"
			return nil
		}

		// Проверяем срок действия.
		now := time.Now()

		if now.Sub(*user.LastCodeSentAt) > smsCodeLifetime {
			status = "CODE_EXPIRED"
			message = "SMS code has expired"
			return nil
		}

		// Проверяем лимит попыток.
		if user.LastCodeAttempts >= smsMaxAttempts {
			status = "TOO_MANY_ATTEMPTS"
			message = "Too many attempts"
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
				message = "Too many attempts"
			} else {
				status = "INVALID_CODE"
				message = "Incorrect SMS code"
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

		// SMS-код подтверждён. Сначала создаём refresh-сессию.
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
		refreshSession := models.UserRefreshToken{
			UserID:    user.ID,
			JTI:       jti,
			UID:       uid,
			ExpiresAt: time.Now().Add(refreshTTL),
			UserAgent: ctx.UA,
			IP:        ctx.IP,
		}
		if err := tx.Create(&refreshSession).Error; err != nil {
			return err
		}

		// Выпускаем access JWT с ID созданной авторизационной сессии.
		access, _, err := issueAccess(&user, uint64(refreshSession.ID))
		if err != nil {
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
				"Device limit: %d. "+
					"Sign out on another device.",
				userMaxDev,
			),
		)
	}

	if err != nil {
		log.Printf("[guestConfirmcode] error: %v", err)

		return smsError(
			ctx,
			"AUTH_ERROR",
			"Authentication failed",
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
