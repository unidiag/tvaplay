package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"main/models"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var apiV2BalancePattern = regexp.MustCompile(
	`^-?(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$`,
)

// apiV2Handler:
// X-API-Key: <API_KEY>
// /api/v2/<FUNC>/...
func apiV2Handler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		apiV2Error(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	// В URL больше нет API-ключа. Проверяем только заголовок.
	expectedKey := strings.TrimSpace(getSetting("api_key"))
	if expectedKey == "" {
		apiV2Error(w, http.StatusServiceUnavailable, "API is disabled")
		return
	}

	providedKey := r.Header.Get("X-API-Key")
	if providedKey == "" {
		apiV2Error(w, http.StatusUnauthorized, "Missing X-API-Key header")
		return
	}

	expectedHash := sha256.Sum256([]byte(expectedKey))
	providedHash := sha256.Sum256([]byte(providedKey))
	if subtle.ConstantTimeCompare(expectedHash[:], providedHash[:]) != 1 {
		apiV2Error(w, http.StatusUnauthorized, "Invalid API key")
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/api/v2/")
	parts := strings.Split(path, "/")
	if len(parts) == 0 || parts[0] == "" {
		apiV2Error(w, http.StatusNotFound, "Invalid API path")
		return
	}

	function := parts[0]

	switch {
	case function == "getUsers" && (len(parts) == 1 || len(parts) == 2):
		status := ""
		if len(parts) == 2 {
			status = parts[1]
		}
		apiV2GetUsers(w, r, status)

	case function == "getUser" && len(parts) == 2:
		apiV2GetUser(w, r, parts[1])

	case function == "delUser" && len(parts) == 2:
		apiV2DelUser(w, r, parts[1])

	case function == "addBalance" && len(parts) == 3:
		apiV2AddBalance(w, r, parts[1], parts[2])

	case function == "adjBalance" && len(parts) == 3:
		apiV2AdjBalance(w, r, parts[1], parts[2])

	case function == "setUser" && len(parts) == 4:
		apiV2SetUser(w, r, parts[1], parts[2], parts[3])

	default:
		apiV2Error(w, http.StatusNotFound, "Unknown API function")
	}
}

// Исключаем секретные поля из ответа.
// Пароль уже скрыт тегом json:"-".
// LastCode в модели пока открыт, поэтому удаляем его
// явно, как и другие возможные секретные поля.
func apiV2PublicUser(
	user models.User,
) (map[string]any, error) {
	raw, err := json.Marshal(user)
	if err != nil {
		return nil, err
	}

	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, err
	}

	delete(data, "password")
	delete(data, "last_code")
	delete(data, "last_code_sent_at")
	delete(data, "last_code_attempts")

	// Поле используется для контроля паузы.
	data["last_paused_at"] = user.LastPausedAt

	return data, nil
}

func apiV2WriteJSON(
	w http.ResponseWriter,
	status int,
	value any,
) {
	body, err := json.Marshal(value)

	if err != nil {
		log.Printf("[API V2] JSON encode: %v", err)

		status = http.StatusInternalServerError
		body = []byte(
			`{"status":"ERROR","message":"JSON encoding error"}`,
		)
	}

	w.Header().Set(
		"Content-Type",
		"application/json; charset=utf-8",
	)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	w.WriteHeader(status)
	_, _ = w.Write(append(body, '\n'))
}

func apiV2Error(
	w http.ResponseWriter,
	status int,
	message string,
) {
	apiV2WriteJSON(w, status, map[string]any{
		"status":  "ERROR",
		"message": message,
	})
}

// Ищем абонента по users.login.

func apiV2FindUser(
	r *http.Request,
	login string,
) (models.User, error) {
	var user models.User

	// Убираем пробелы вокруг номера.
	login = strings.TrimSpace(login)

	// Поддерживаем оба формата:
	// 375297153616 и +375297153616.
	normalized := strings.TrimPrefix(login, "+")

	err := db.WithContext(r.Context()).
		Where(
			"login = ? OR login = ?",
			normalized,
			"+"+normalized,
		).
		Order("id ASC").
		First(&user).Error

	return user, err
}

func apiV2UserError(
	w http.ResponseWriter,
	err error,
) {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		apiV2Error(
			w, http.StatusNotFound,
			"User not found",
		)
		return
	}

	log.Printf("[API V2] database: %v", err)
	apiV2Error(
		w, http.StatusInternalServerError,
		"Database error",
	)
}

// GET /api/v2/getUsers
// GET /api/v2/getUsers/<STATUS>
func apiV2GetUsers(
	w http.ResponseWriter,
	r *http.Request,
	statusText string,
) {
	if r.Method != http.MethodGet {
		apiV2Error(
			w,
			http.StatusMethodNotAllowed,
			"GET required",
		)
		return
	}

	query := db.WithContext(r.Context()).
		Model(&models.User{})

	// Если указан STATUS, фильтруем пользователей.
	if statusText != "" {
		status, err := strconv.ParseUint(
			statusText, 10, 8,
		)

		if err != nil || status > 9 {
			apiV2Error(
				w,
				http.StatusBadRequest,
				"Invalid user status (allowed: 0-9)",
			)
			return
		}

		query = query.Where("status = ?", status)
	}

	var users []models.User

	if err := query.
		Order("id ASC").
		Find(&users).Error; err != nil {

		apiV2UserError(w, err)
		return
	}

	result := make(
		[]map[string]any,
		0,
		len(users),
	)

	for _, user := range users {
		data, err := apiV2PublicUser(user)

		if err != nil {
			apiV2Error(
				w,
				http.StatusInternalServerError,
				"JSON encoding error",
			)
			return
		}

		result = append(result, data)
	}

	// Даже если пользователей нет,
	// возвращаем пустой массив [], а не null.
	apiV2WriteJSON(
		w,
		http.StatusOK,
		result,
	)
}

// GET /api/v2/getUser/<LOGIN>
func apiV2GetUser(
	w http.ResponseWriter,
	r *http.Request,
	login string,
) {
	if r.Method != http.MethodGet {
		apiV2Error(
			w, http.StatusMethodNotAllowed,
			"GET required",
		)
		return
	}

	user, err := apiV2FindUser(r, login)
	if err != nil {
		apiV2UserError(w, err)
		return
	}

	userData, err := apiV2PublicUser(user)
	if err != nil {
		apiV2Error(
			w, http.StatusInternalServerError,
			"JSON encoding error",
		)
		return
	}

	// Загружаем все сессии абонента,
	// включая истёкшие, если они сохранились в БД.
	var tokens []models.UserRefreshToken

	err = db.WithContext(r.Context()).
		Where("user_id = ?", user.ID).
		Order("created_at DESC, id DESC").
		Find(&tokens).Error

	if err != nil {
		apiV2UserError(w, err)
		return
	}

	sessions := make([]map[string]any, 0, len(tokens))
	now := time.Now()

	for _, token := range tokens {
		sessions = append(sessions, map[string]any{
			"id":         token.ID,
			"uid":        token.UID,
			"ip":         token.IP,
			"user_agent": token.UserAgent,
			"created_at": token.CreatedAt,
			"expires_at": token.ExpiresAt,
			"active":     token.ExpiresAt.After(now),
		})
	}

	// Загружаем связи пользователя с пакетами.
	var links []models.UserPackage

	err = db.WithContext(r.Context()).
		Where("user_id = ?", user.ID).
		Order("package_id ASC").
		Find(&links).Error

	if err != nil {
		apiV2UserError(w, err)
		return
	}

	packages := make([]map[string]any, 0, len(links))

	if len(links) > 0 {
		ids := make([]uint32, 0, len(links))
		enabledTimes := make(map[uint32]*time.Time)

		for _, link := range links {
			ids = append(ids, link.PackageID)
			enabledTimes[link.PackageID] = link.EnabledAt
		}

		var found []models.Package

		err = db.WithContext(r.Context()).
			Where("id IN ?", ids).
			Order("position ASC, id ASC").
			Find(&found).Error

		if err != nil {
			apiV2UserError(w, err)
			return
		}

		for _, pkg := range found {
			raw, err := json.Marshal(pkg)
			if err != nil {
				apiV2Error(
					w, http.StatusInternalServerError,
					"JSON encoding error",
				)
				return
			}

			var item map[string]any
			if err := json.Unmarshal(raw, &item); err != nil {
				apiV2Error(
					w, http.StatusInternalServerError,
					"JSON encoding error",
				)
				return
			}

			enabledAt := enabledTimes[pkg.ID]
			item["enabled_at"] = enabledAt

			availableAt := packageDisableAvailableAt(
				enabledAt,
			)
			item["disable_available_at"] = availableAt

			packages = append(packages, item)
		}
	}

	apiV2WriteJSON(
		w, http.StatusOK,
		map[string]any{
			"user":     userData,
			"sessions": sessions,
			"packages": packages,
		},
	)
}

// GET/POST /api/v2/delUser/<LOGIN>
// Удаляем только refresh-сессии.
// Запись users и пакеты не затрагиваем.
func apiV2DelUser(
	w http.ResponseWriter,
	r *http.Request,
	login string,
) {
	user, err := apiV2FindUser(r, login)
	if err != nil {
		apiV2UserError(w, err)
		return
	}

	result := db.WithContext(r.Context()).
		Where("user_id = ?", user.ID).
		Delete(&models.UserRefreshToken{})

	if result.Error != nil {
		apiV2UserError(w, result.Error)
		return
	}

	apiV2WriteJSON(
		w, http.StatusOK,
		map[string]any{
			"status":           "OK",
			"login":            user.Login,
			"deleted_sessions": result.RowsAffected,
		},
	)
}

// All monetary operations use integer kopecks in Go, never float64.
// A DECIMAL(12,2) column supports values up to +/-9999999999.99.
const apiV2MaxBalanceCents int64 = 999999999999

func apiV2MoneyCents(value string) (int64, error) {
	if !apiV2BalancePattern.MatchString(value) {
		return 0, errors.New("invalid money amount")
	}

	negative := strings.HasPrefix(value, "-")
	unsigned := strings.TrimPrefix(value, "-")
	parts := strings.SplitN(unsigned, ".", 2)
	whole, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return 0, err
	}
	fractional := "00"
	if len(parts) == 2 {
		fractional = (parts[1] + "00")[:2]
	}
	cents, err := strconv.ParseInt(fractional, 10, 64)
	if err != nil {
		return 0, err
	}
	result := whole*100 + cents
	if result > apiV2MaxBalanceCents {
		return 0, errors.New("money amount out of range")
	}
	if negative {
		result = -result
	}
	return result, nil
}

func apiV2MoneyString(cents int64) string {
	prefix := ""
	if cents < 0 {
		prefix = "-"
		cents = -cents
	}
	return fmt.Sprintf("%s%d.%02d", prefix, cents/100, cents%100)
}

// When an external request ID is provided, retrying addBalance is safe.
// Without it, each request is considered a separate top-up.
func apiV2OperationKey(r *http.Request, scope string, userID uint) (string, error) {
	requestID := strings.TrimSpace(r.Header.Get("X-Idempotency-Key"))

	if requestID != "" {
		if len(requestID) > 128 || strings.ContainsAny(requestID, "\r\n") {
			return "", errors.New("invalid idempotency key")
		}

		data := fmt.Appendf(nil, "%s:%d:%s", scope, userID, requestID)
		digest := sha256.Sum256(data)

		return scope + ":" + hex.EncodeToString(digest[:]), nil
	}

	data := make([]byte, 16)

	if _, err := rand.Read(data); err != nil {
		return "", err
	}

	return scope + ":" + hex.EncodeToString(data), nil
}

// Caller must have locked the user row FOR UPDATE in the same transaction.
// The balance update and its ledger entry are committed or rolled back together.
func apiV2WriteBalanceTransaction(
	tx *gorm.DB,
	user *models.User,
	transactionType string,
	valueCents int64,
	absolute bool,
	operationKey string,
) (*models.BalanceTransaction, bool, error) {
	currentCents, err := apiV2MoneyCents(user.Balance)
	if err != nil {
		return nil, false, fmt.Errorf("invalid current balance: %w", err)
	}

	// The operation key is unique even across concurrent workers.
	var previous models.BalanceTransaction
	err = tx.Where("operation_key = ?", operationKey).First(&previous).Error
	if err == nil {
		if previous.UserID != user.ID || previous.Type != transactionType {
			return nil, false, errors.New("idempotency key conflict")
		}
		recordedCents, parseErr := apiV2MoneyCents(previous.Amount)
		if parseErr != nil {
			return nil, false, parseErr
		}
		expected := valueCents
		if absolute {
			// An absolute balance write is never replayed implicitly.
			return nil, false, errors.New("idempotency key conflict")
		}
		if recordedCents != expected {
			return nil, false, errors.New("idempotency key conflict")
		}
		return &previous, true, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, false, err
	}

	newCents := valueCents
	if !absolute {
		newCents = currentCents + valueCents
	}
	if newCents > apiV2MaxBalanceCents || newCents < -apiV2MaxBalanceCents {
		return nil, false, errors.New("balance out of range")
	}
	difference := newCents - currentCents
	if difference > apiV2MaxBalanceCents || difference < -apiV2MaxBalanceCents {
		return nil, false, errors.New("balance change out of range")
	}
	// No financial movement; skip the journal row on setBalance no-ops.
	if difference == 0 {
		return nil, false, nil
	}

	updated := tx.Model(&models.User{}).
		Where("id = ?", user.ID).
		Update("balance", apiV2MoneyString(newCents))
	if updated.Error != nil {
		return nil, false, updated.Error
	}
	if updated.RowsAffected != 1 {
		return nil, false, errors.New("balance update failed")
	}

	var after struct {
		Value string `gorm:"column:balance"`
	}
	read := tx.Raw("SELECT CAST(balance AS CHAR) AS balance FROM users WHERE id = ?", user.ID).Scan(&after)
	if read.Error != nil {
		return nil, false, read.Error
	}
	if read.RowsAffected != 1 || strings.TrimSpace(after.Value) == "" {
		return nil, false, errors.New("failed to read balance after update")
	}

	ledger := models.BalanceTransaction{
		UserID:       user.ID,
		Type:         transactionType,
		Amount:       apiV2MoneyString(difference),
		BalanceAfter: &after.Value,
		OperationKey: operationKey,
	}
	if err := tx.Create(&ledger).Error; err != nil {
		return nil, false, err
	}
	user.Balance = after.Value
	return &ledger, false, nil
}

// GET/POST /api/v2/addBalance/<BillingID>/<AMOUNT>
// For financial integrations prefer POST + X-Idempotency-Key.
func apiV2AddBalance(w http.ResponseWriter, r *http.Request, billingIDText, amountText string) {
	billingID, err := strconv.ParseUint(billingIDText, 10, 64)
	if err != nil || billingID == 0 {
		apiV2Error(w, http.StatusBadRequest, "Invalid billing ID")
		return
	}
	cents, err := apiV2MoneyCents(amountText)
	if err != nil || cents <= 0 {
		apiV2Error(w, http.StatusBadRequest, "Invalid top-up amount")
		return
	}
	var user models.User
	var ledger *models.BalanceTransaction
	var repeated bool
	err = db.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
		// Reject ambiguous external IDs rather than crediting a random subscriber.
		var matches []models.User
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("billing_id = ?", billingID).
			Order("id ASC").Limit(2).Find(&matches).Error; err != nil {
			return err
		}
		if len(matches) == 0 {
			return gorm.ErrRecordNotFound
		}
		if len(matches) != 1 {
			return errors.New("duplicate billing ID")
		}
		user = matches[0]
		key, err := apiV2OperationKey(r, "v2add", user.ID)
		if err != nil {
			return err
		}
		ledger, repeated, err = apiV2WriteBalanceTransaction(
			tx, &user, models.BalanceTopup, cents, false, key,
		)
		return err
	})
	if err != nil {
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			apiV2Error(w, http.StatusNotFound, "Billing ID not found")
		case err.Error() == "duplicate billing ID":
			apiV2Error(w, http.StatusConflict, "Billing ID is not unique")
		case err.Error() == "idempotency key conflict":
			apiV2Error(w, http.StatusConflict, "Idempotency key was already used for another operation")
		case err.Error() == "balance out of range" || err.Error() == "balance change out of range":
			apiV2Error(w, http.StatusBadRequest, "Balance exceeds DECIMAL(12,2) range")
		case err.Error() == "invalid idempotency key":
			apiV2Error(w, http.StatusBadRequest, "Invalid X-Idempotency-Key")
		default:
			log.Printf("[API V2] addBalance billing_id=%d: %v", billingID, err)
			apiV2Error(w, http.StatusInternalServerError, "Failed to add balance")
		}
		return
	}
	resultBalance := user.Balance
	if repeated && ledger != nil && ledger.BalanceAfter != nil {
		resultBalance = *ledger.BalanceAfter
	}
	apiV2WriteJSON(w, http.StatusOK, map[string]any{
		"status": "OK", "billing_id": billingID,
		"login": user.Login, "amount": apiV2MoneyString(cents),
		"balance": resultBalance, "repeated": repeated,
		"transaction_id": ledger.ID,
	})
}

// GET/POST /api/v2/adjBalance/<BillingID>/<AMOUNT>
// Positive amount credits the balance, negative amount debits it.
// For financial integrations prefer POST + X-Idempotency-Key.
func apiV2AdjBalance(w http.ResponseWriter, r *http.Request, billingIDText, amountText string) {
	billingID, err := strconv.ParseUint(billingIDText, 10, 64)
	if err != nil || billingID == 0 {
		apiV2Error(w, http.StatusBadRequest, "Invalid billing ID")
		return
	}

	cents, err := apiV2MoneyCents(amountText)
	if err != nil || cents == 0 {
		apiV2Error(w, http.StatusBadRequest, "Invalid adjustment amount")
		return
	}

	var user models.User
	var ledger *models.BalanceTransaction
	var repeated bool

	err = db.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
		// Block the account, rejecting nonunique billing IDs.
		var matches []models.User
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("billing_id = ?", billingID).
			Order("id ASC").Limit(2).Find(&matches).Error; err != nil {
			return err
		}
		if len(matches) == 0 {
			return gorm.ErrRecordNotFound
		}
		if len(matches) != 1 {
			return errors.New("duplicate billing ID")
		}
		user = matches[0]

		key, err := apiV2OperationKey(r, "v2adj", user.ID)
		if err != nil {
			return err
		}

		ledger, repeated, err = apiV2WriteBalanceTransaction(
			tx, &user, models.BalanceAdjustment, cents, false, key,
		)
		return err
	})
	if err != nil {
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			apiV2Error(w, http.StatusNotFound, "Billing ID not found")
		case err.Error() == "duplicate billing ID":
			apiV2Error(w, http.StatusConflict, "Billing ID is not unique")
		case err.Error() == "idempotency key conflict":
			apiV2Error(w, http.StatusConflict, "Idempotency key was already used for another operation")
		case err.Error() == "balance out of range" || err.Error() == "balance change out of range":
			apiV2Error(w, http.StatusBadRequest, "Balance exceeds DECIMAL(12,2) range")
		case err.Error() == "invalid idempotency key":
			apiV2Error(w, http.StatusBadRequest, "Invalid X-Idempotency-Key")
		default:
			log.Printf("[API V2] adjBalance billing_id=%d: %v", billingID, err)
			apiV2Error(w, http.StatusInternalServerError, "Failed to adjust balance")
		}
		return
	}

	resultBalance := user.Balance
	if repeated && ledger != nil && ledger.BalanceAfter != nil {
		resultBalance = *ledger.BalanceAfter
	}
	apiV2WriteJSON(w, http.StatusOK, map[string]any{
		"status": "OK", "billing_id": billingID,
		"login": user.Login, "amount": apiV2MoneyString(cents),
		"balance": resultBalance, "repeated": repeated,
		"transaction_id": ledger.ID,
	})
}

// GET/POST /api/v2/setUser/<LOGIN>/<FIELD>/<VALUE>
func apiV2SetUser(w http.ResponseWriter, r *http.Request, login, field, value string) {
	if field != "status" &&
		field != "balance" &&
		field != "info" &&
		field != "billing_id" {

		apiV2Error(
			w,
			http.StatusBadRequest,
			"Unsupported user field",
		)
		return
	}

	user, err := apiV2FindUser(r, login)
	if err != nil {
		apiV2UserError(w, err)
		return
	}

	if field == "balance" {
		cents, err := apiV2MoneyCents(value)
		if err != nil {
			apiV2Error(w, http.StatusBadRequest, "Invalid balance")
			return
		}
		var ledger *models.BalanceTransaction
		err = db.WithContext(r.Context()).Transaction(func(tx *gorm.DB) error {
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&user, user.ID).Error; err != nil {
				return err
			}
			// A new setUser request is a new adjustment, even with the same amount.
			operationKey, err := apiV2OperationKey(r, "v2set", user.ID)
			if err != nil {
				return err
			}
			ledger, _, err = apiV2WriteBalanceTransaction(
				tx, &user, models.BalanceSet, cents, true, operationKey,
			)
			return err
		})
		if err != nil {
			if err.Error() == "balance change out of range" || err.Error() == "balance out of range" {
				apiV2Error(w, http.StatusBadRequest, "Balance change exceeds DECIMAL(12,2) range")
			} else {
				log.Printf("[API V2] setUser balance user_id=%d: %v", user.ID, err)
				apiV2Error(w, http.StatusInternalServerError, "Failed to set balance")
			}
			return
		}
		result := map[string]any{
			"status": "OK", "login": user.Login, "field": "balance", "value": user.Balance,
		}
		if ledger != nil {
			result["transaction_id"] = ledger.ID
		}
		apiV2WriteJSON(w, http.StatusOK, result)
		return
	}

	if field == "billing_id" {
		// 0 — абонент не сопряжён с биллинговой системой.
		billingID, err := strconv.ParseUint(value, 10, 64)
		if err != nil {
			apiV2Error(
				w,
				http.StatusBadRequest,
				"Invalid billing ID",
			)
			return
		}

		// Обновляем идентификатор в транзакции.
		err = db.WithContext(r.Context()).Transaction(
			func(tx *gorm.DB) error {
				// Блокируем изменяемого абонента.
				if err := tx.Clauses(
					clause.Locking{Strength: "UPDATE"},
				).First(&user, user.ID).Error; err != nil {
					return err
				}

				// Проверяем, не принадлежит ли ID другому абоненту.
				var count int64

				// Проверяем уникальность только положительных billing_id.
				// Значение 0 допускается для любого количества абонентов.
				if billingID > 0 {
					var count int64

					if err := tx.Model(&models.User{}).
						Where(
							"billing_id = ? AND id <> ?",
							billingID,
							user.ID,
						).
						Count(&count).Error; err != nil {
						return err
					}

					if count > 0 {
						return errors.New("billing ID already exists")
					}
				}

				if count > 0 {
					return errors.New("billing ID already exists")
				}

				// Записываем новый идентификатор.
				return tx.Model(&models.User{}).
					Where("id = ?", user.ID).
					Update("billing_id", billingID).Error
			},
		)

		if err != nil {
			if err.Error() == "billing ID already exists" {
				apiV2Error(
					w,
					http.StatusConflict,
					"Billing ID is already assigned to another user",
				)
				return
			}

			apiV2UserError(w, err)
			return
		}

		apiV2WriteJSON(
			w,
			http.StatusOK,
			map[string]any{
				"status": "OK",
				"login":  user.Login,
				"field":  "billing_id",
				"value":  billingID,
			},
		)

		return
	}

	var newValue any
	if field == "status" {
		status, err := strconv.ParseUint(value, 10, 8)
		if err != nil || status > 7 {
			apiV2Error(w, http.StatusBadRequest, "Invalid user status")
			return
		}
		newValue = uint(status)
	} else {
		decoded := strings.ReplaceAll(value, "+", " ")
		if !utf8.ValidString(decoded) {
			apiV2Error(w, http.StatusBadRequest, "Invalid UTF-8 info")
			return
		}
		if len(decoded) > 10000 {
			apiV2Error(w, http.StatusBadRequest, "Info is too long")
			return
		}
		newValue = decoded
	}

	err = db.WithContext(r.Context()).Model(&models.User{}).
		Where("id = ?", user.ID).Update(field, newValue).Error
	if err != nil {
		apiV2UserError(w, err)
		return
	}

	var updated models.User
	if err := db.WithContext(r.Context()).First(&updated, user.ID).Error; err != nil {
		apiV2UserError(w, err)
		return
	}
	var resultValue any
	if field == "status" {
		resultValue = updated.Status
	} else {
		resultValue = updated.Info
	}
	apiV2WriteJSON(w, http.StatusOK, map[string]any{
		"status": "OK", "login": updated.Login, "field": field, "value": resultValue,
	})
}
