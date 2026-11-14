package main

import (
	"errors"
	"fmt"
	"main/models"
	"math/big"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Keep administrative responses limited to profile fields. In particular,
// never serialize password, SMS codes, refresh tokens or other auth secrets.
type adminUserRow struct {
	ID             uint     `json:"id"`
	Login          string   `json:"login"`
	BillingID      uint64   `json:"billing_id"`
	Status         uint     `json:"status"`
	MaxDev         uint     `json:"max_dev"`
	Info           string   `json:"info"`
	Balance        string   `json:"balance"`
	LastActive     any      `json:"last_active"`
	LastIP         string   `json:"last_ip"`
	LoginAt        any      `json:"login_at"`
	CreatedAt      any      `json:"created_at"`
	UpdatedAt      any      `json:"updated_at"`
	PackageIDs     []uint32 `json:"package_ids"`
	ActiveSessions int64    `json:"active_sessions"`
	Online         int64    `json:"online"`
}

// DECIMAL(12,2) permits up to ten digits before the decimal separator.
var adminBalancePattern = regexp.MustCompile(`^-?(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$`)

func parseAdminBalance(value string) (string, error) {
	value = strings.TrimSpace(value)
	if !adminBalancePattern.MatchString(value) {
		return "", errors.New("Balance must be a valid amount with up to 2 decimal places")
	}
	return value, nil
}

func equalAdminBalances(a, b string) bool {
	x, okA := new(big.Rat).SetString(a)
	y, okB := new(big.Rat).SetString(b)
	return okA && okB && x.Cmp(y) == 0
}

func adminUserError(ctx *ApiCtx, status, message string) map[string]any {
	ctx.Out["status"] = status
	ctx.Out["message"] = message
	return ctx.Out
}

func parseAdminUserID(s string) (uint, error) {
	n, err := strconv.ParseUint(strings.TrimSpace(s), 10, 64)
	if err != nil || n == 0 || uint64(uint(n)) != n {
		return 0, errors.New("invalid user ID")
	}
	return uint(n), nil
}

func parseAdminPackageIDs(value any) ([]uint32, error) {
	raw, ok := value.([]any)
	if !ok || len(raw) > 10000 {
		return nil, errors.New("Invalid package list")
	}
	ids := make([]uint32, 0, len(raw))
	seen := make(map[uint32]struct{}, len(raw))
	for _, v := range raw {
		var valueText string
		switch x := v.(type) {
		case float64:
			if x != float64(uint64(x)) || x < 1 || x > 4294967295 {
				return nil, errors.New("Invalid package ID")
			}
			valueText = strconv.FormatUint(uint64(x), 10)
		case string:
			valueText = x
		default:
			return nil, errors.New("Invalid package ID")
		}
		n, err := strconv.ParseUint(valueText, 10, 32)
		if err != nil || n == 0 {
			return nil, errors.New("Invalid package ID")
		}
		id := uint32(n)
		if _, duplicate := seen[id]; duplicate {
			return nil, errors.New("Duplicate package ID")
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids, nil
}

// POST {"op":"adminUsers"}
func apiAdminUsers(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}
	var users []models.User
	if err := db.Order("id DESC").Find(&users).Error; err != nil {
		return adminUserError(ctx, "NOK", "Cannot load users")
	}
	var links []models.UserPackage
	if err := db.Find(&links).Error; err != nil {
		return adminUserError(ctx, "NOK", "Cannot load user packages")
	}

	// Одним запросом считаем действующие сессии и проверяем,
	// есть ли хотя бы один успешный refresh за последние 10 минут.
	const onlineTimeout = 10 * time.Minute
	now := time.Now()

	var sessionCounts []struct {
		UserID uint  `gorm:"column:user_id"`
		Total  int64 `gorm:"column:total"`
		Online int64 `gorm:"column:online"`
	}

	if err := db.Model(&models.UserRefreshToken{}).
		Select(
			"user_id, COUNT(*) AS total, "+
				"SUM(CASE WHEN updated_at >= ? AND updated_at <= ? "+
				"THEN 1 ELSE 0 END) AS online",
			now.Add(-onlineTimeout), now,
		).
		Where("expires_at > ?", now).
		Group("user_id").
		Scan(&sessionCounts).Error; err != nil {

		return adminUserError(
			ctx, "NOK", "Cannot load active sessions",
		)
	}

	activeByUser := make(map[uint]int64, len(sessionCounts))
	onlineByUser := make(map[uint]int64, len(sessionCounts))

	for _, item := range sessionCounts {
		activeByUser[item.UserID] = item.Total
		onlineByUser[item.UserID] = item.Online
	}

	byUser := make(map[uint][]uint32)
	for _, link := range links {
		byUser[link.UserID] = append(byUser[link.UserID], link.PackageID)
	}
	rows := make([]adminUserRow, 0, len(users))
	for _, user := range users {
		ids := byUser[user.ID]
		if ids == nil {
			ids = []uint32{}
		}
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
		rows = append(rows, adminUserRow{
			ID:             user.ID,
			Login:          user.Login,
			BillingID:      uint64(user.BillingID),
			Status:         user.Status,
			MaxDev:         user.MaxDev,
			Info:           user.Info,
			Balance:        user.Balance,
			LastActive:     user.LastActive,
			LastIP:         user.LastIP,
			LoginAt:        user.LoginAt,
			CreatedAt:      user.CreatedAt,
			UpdatedAt:      user.UpdatedAt,
			PackageIDs:     ids,
			ActiveSessions: activeByUser[user.ID],
			Online:         onlineByUser[user.ID],
		})
	}
	ctx.Out["users"] = rows
	if ctx.User != nil {
		ctx.Out["current_user_status"] = ctx.User.Status
	}
	return ctx.Out
}

//
// POST {
//   "op": "adminUserSave",
//   "id": 1,
//   "login": "375291234567",
//   "billing_id": "5544",
//   "status": 1,
//   "max_dev": 3,
//   "info": "",
//   "balance": "10.00",
//   "package_ids": [1, 2]
// }
//

func apiAdminUserSave(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}

	// -------------------------------------------------
	// ID абонента
	// -------------------------------------------------

	id, err := parseAdminUserID(ctx.D["id"])
	if err != nil {
		return adminUserError(
			ctx,
			"INVALID_USER",
			"Invalid user ID",
		)
	}

	// -------------------------------------------------
	// Логин
	// -------------------------------------------------

	login := strings.TrimSpace(ctx.D["login"])

	if login == "" || len(login) > 15 {
		return adminUserError(
			ctx,
			"INVALID_LOGIN",
			"Login must be 1–15 characters",
		)
	}

	// -------------------------------------------------
	// Billing ID
	// 0 — идентификатор не назначен.
	// Положительные значения должны быть уникальны.
	// -------------------------------------------------

	billingIDText := strings.TrimSpace(ctx.D["billing_id"])

	billingID, err := strconv.ParseUint(
		billingIDText,
		10,
		64,
	)

	if err != nil {
		return adminUserError(
			ctx,
			"INVALID_BILLING_ID",
			"Billing ID must be a non-negative integer",
		)
	}

	// -------------------------------------------------
	// Статус абонента
	// -------------------------------------------------

	status, err := strconv.ParseUint(
		strings.TrimSpace(ctx.D["status"]),
		10,
		32,
	)

	if err != nil {
		return adminUserError(
			ctx,
			"INVALID_STATUS",
			"Invalid user status",
		)
	}

	switch status {
	case 0, 1, 2, 8, 9:
		// Допустимые статусы.
	default:
		return adminUserError(
			ctx,
			"INVALID_STATUS",
			"Unsupported user status",
		)
	}

	// -------------------------------------------------
	// Максимальное количество устройств
	// -------------------------------------------------

	maxDev, err := strconv.ParseUint(
		strings.TrimSpace(ctx.D["max_dev"]),
		10,
		32,
	)

	if err != nil || maxDev < 1 || maxDev > 1000 {
		return adminUserError(
			ctx,
			"INVALID_MAX_DEV",
			"Max devices must be between 1 and 1000",
		)
	}

	// -------------------------------------------------
	// Дополнительная информация
	// -------------------------------------------------

	info := ctx.D["info"]

	if len([]rune(info)) > 10000 {
		return adminUserError(
			ctx,
			"INVALID_INFO",
			"Info must not exceed 10000 characters",
		)
	}

	// -------------------------------------------------
	// Баланс
	// -------------------------------------------------

	balance, err := parseAdminBalance(ctx.D["balance"])
	if err != nil {
		return adminUserError(
			ctx,
			"INVALID_BALANCE",
			err.Error(),
		)
	}

	// -------------------------------------------------
	// Подключённые пакеты
	// -------------------------------------------------

	ids, err := parseAdminPackageIDs(
		ctx.Data["package_ids"],
	)

	if err != nil {
		return adminUserError(
			ctx,
			"INVALID_PACKAGES",
			err.Error(),
		)
	}

	// -------------------------------------------------
	// Защита от потери собственных прав
	// -------------------------------------------------

	if ctx.User != nil &&
		ctx.User.ID == id &&
		status < 8 {

		return adminUserError(
			ctx,
			"INVALID_STATUS",
			"You cannot remove your own administrator access",
		)
	}

	// -------------------------------------------------
	// Транзакция
	// -------------------------------------------------

	err = db.Transaction(func(tx *gorm.DB) error {
		var user models.User

		// Блокируем запись абонента до завершения
		// транзакции, чтобы избежать одновременных
		// конфликтующих изменений.
		if err := tx.
			Clauses(clause.Locking{
				Strength: "UPDATE",
			}).
			First(&user, id).Error; err != nil {

			return err
		}

		isAdministrator := ctx.User != nil &&
			ctx.User.Status == 9

		// ---------------------------------------------
		// Проверка прав на изменение статуса
		// ---------------------------------------------

		if !isAdministrator &&
			status != uint64(user.Status) {

			return errors.New(
				"FORBIDDEN_STATUS_CHANGE",
			)
		}

		// ---------------------------------------------
		// Проверка прав на изменение баланса
		// ---------------------------------------------

		if !isAdministrator &&
			!equalAdminBalances(balance, user.Balance) {

			return errors.New(
				"FORBIDDEN_BALANCE_CHANGE",
			)
		}

		// ---------------------------------------------
		// Проверка прав на изменение Billing ID
		// ---------------------------------------------

		if !isAdministrator &&
			billingID != uint64(user.BillingID) {

			return errors.New(
				"FORBIDDEN_BILLING_ID_CHANGE",
			)
		}

		// ---------------------------------------------
		// Проверка уникальности Billing ID
		// ---------------------------------------------

		if isAdministrator &&
			billingID > 0 &&
			billingID != uint64(user.BillingID) {

			var count int64

			if err := tx.Model(&models.User{}).
				Where(
					"billing_id = ? AND id <> ?",
					billingID,
					id,
				).
				Count(&count).Error; err != nil {

				return err
			}

			if count > 0 {
				return errors.New(
					"DUPLICATE_BILLING_ID",
				)
			}
		}

		// ---------------------------------------------
		// Проверка существования пакетов
		// ---------------------------------------------

		if len(ids) > 0 {
			var count int64

			if err := tx.
				Model(&models.Package{}).
				Where("id IN ?", ids).
				Count(&count).Error; err != nil {

				return err
			}

			if count != int64(len(ids)) {
				return errors.New(
					"One or more packages no longer exist",
				)
			}
		}

		// ---------------------------------------------
		// Формирование изменений
		// ---------------------------------------------

		updates := map[string]any{
			"login":   login,
			"max_dev": uint(maxDev),
			"info":    info,
		}

		// Только администратор со статусом 9
		// может изменять финансовые и системные поля.
		if isAdministrator {
			updates["status"] = uint(status)
			updates["balance"] = balance
			updates["billing_id"] = billingID
		}

		// ---------------------------------------------
		// Сохранение пользователя
		// ---------------------------------------------

		if err := tx.
			Model(&user).
			Updates(updates).Error; err != nil {

			return err
		}

		// ---------------------------------------------
		// Обновление пакетов
		// ---------------------------------------------

		if err := tx.
			Where("user_id = ?", id).
			Delete(&models.UserPackage{}).Error; err != nil {

			return err
		}

		if len(ids) > 0 {
			links := make(
				[]models.UserPackage,
				0,
				len(ids),
			)

			for _, pkgID := range ids {
				links = append(
					links,
					models.UserPackage{
						UserID:    id,
						PackageID: pkgID,
					},
				)
			}

			if err := tx.
				Create(&links).Error; err != nil {

				return err
			}
		}

		return nil
	})

	// -------------------------------------------------
	// Обработка ошибок транзакции
	// -------------------------------------------------

	if err != nil {
		switch err.Error() {

		case "FORBIDDEN_STATUS_CHANGE":
			return adminUserError(
				ctx,
				"FORBIDDEN",
				"Only administrators with status 9 can change user status",
			)

		case "FORBIDDEN_BALANCE_CHANGE":
			return adminUserError(
				ctx,
				"FORBIDDEN",
				"Only administrators with status 9 can change user balance",
			)

		case "FORBIDDEN_BILLING_ID_CHANGE":
			return adminUserError(
				ctx,
				"FORBIDDEN",
				"Only administrators with status 9 can change Billing ID",
			)

		case "DUPLICATE_BILLING_ID":
			return adminUserError(
				ctx,
				"DUPLICATE_BILLING_ID",
				"This Billing ID is already assigned to another user",
			)
		}

		if errors.Is(err, gorm.ErrRecordNotFound) {
			return adminUserError(
				ctx,
				"USER_NOT_FOUND",
				"User not found",
			)
		}

		// Обработка уникальных индексов MySQL.
		// Включая функциональный индекс Billing ID.
		errText := strings.ToLower(err.Error())

		if strings.Contains(
			errText,
			"ux_users_billing_id_positive",
		) {
			return adminUserError(
				ctx,
				"DUPLICATE_BILLING_ID",
				"This Billing ID is already assigned to another user",
			)
		}

		if strings.Contains(errText, "duplicate") {
			return adminUserError(
				ctx,
				"DUPLICATE_LOGIN",
				"This login is already in use",
			)
		}

		return adminUserError(
			ctx,
			"NOK",
			fmt.Sprintf("Cannot save user: %v", err),
		)
	}

	// -------------------------------------------------
	// Успешный ответ
	// -------------------------------------------------

	ctx.Out["id"] = id
	ctx.Out["billing_id"] = billingID

	return ctx.Out
}

func apiAdminUserSessions(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}

	id, err := parseAdminUserID(ctx.D["id"])
	if err != nil {
		return adminUserError(
			ctx,
			"INVALID_USER",
			"Invalid user ID",
		)
	}

	var user models.User

	if err := db.Select(
		"id", "login", "max_dev",
	).First(&user, id).Error; err != nil {

		if errors.Is(err, gorm.ErrRecordNotFound) {
			return adminUserError(
				ctx, "USER_NOT_FOUND", "User not found",
			)
		}

		return adminUserError(
			ctx, "NOK", "Cannot load user",
		)
	}

	var tokens []models.UserRefreshToken

	if err := db.
		Where("user_id = ?", id).
		Order("created_at DESC, id DESC").
		Find(&tokens).Error; err != nil {

		return adminUserError(
			ctx, "NOK", "Cannot load sessions",
		)
	}

	now := time.Now()

	sessions := make([]map[string]any, 0, len(tokens))
	activeCount := 0
	onlineCount := 0

	const onlineTimeout = 10 * time.Minute

	for _, token := range tokens {
		active := token.ExpiresAt.After(now)

		online := active &&
			!token.UpdatedAt.After(now) &&
			now.Sub(token.UpdatedAt) <= onlineTimeout

		if active {
			activeCount++
		}

		if online {
			onlineCount++
		}

		sessions = append(sessions, map[string]any{
			"id":         token.ID,
			"uid":        token.UID,
			"ip":         token.IP,
			"country":    geoIP(token.IP),
			"user_agent": token.UserAgent,
			"created_at": token.CreatedAt,
			"updated_at": token.UpdatedAt,
			"expires_at": token.ExpiresAt,
			"active":     active,
			"online":     online,
		})
	}

	ctx.Out["user_id"] = user.ID
	ctx.Out["login"] = user.Login
	ctx.Out["max_dev"] = user.MaxDev
	ctx.Out["active_sessions"] = activeCount
	ctx.Out["online_sessions"] = onlineCount
	ctx.Out["sessions"] = sessions

	return ctx.Out
}

// Зарегистрировать как op="adminUserSessionDelete" в существующем API router.
// POST {"op":"adminUserSessionDelete", "id":"123", "session_id":"456"}
func apiAdminUserSessionDelete(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}

	userID, err := parseAdminUserID(ctx.D["id"])
	if err != nil {
		return adminUserError(ctx, "INVALID_USER", "Invalid user ID")
	}

	sessionID, err := strconv.ParseUint(strings.TrimSpace(ctx.D["session_id"]), 10, 64)
	if err != nil || sessionID == 0 {
		return adminUserError(ctx, "INVALID_SESSION", "Invalid session ID")
	}

	var activeCount int64
	err = db.Transaction(func(tx *gorm.DB) error {
		// Не даём удалить запись другого абонента через подмену ID.
		result := tx.Where("id = ? AND user_id = ?", sessionID, userID).
			Delete(&models.UserRefreshToken{})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}

		return tx.Model(&models.UserRefreshToken{}).
			Where("user_id = ? AND expires_at > ?", userID, time.Now()).
			Count(&activeCount).Error
	})

	if errors.Is(err, gorm.ErrRecordNotFound) {
		return adminUserError(ctx, "SESSION_NOT_FOUND", "Session not found for this user")
	}
	if err != nil {
		return adminUserError(ctx, "NOK", "Cannot delete session")
	}

	ctx.Out["deleted_session_id"] = sessionID
	ctx.Out["active_sessions"] = activeCount
	return ctx.Out
}

// POST {"op":"adminUserBalanceTransactions","id":"123"}
// Возвращает только последние 100 записей финансового журнала абонента.
// Требует права администратора; не раскрывает operation_key и другие служебные данные.
func apiAdminUserBalanceTransactions(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}

	userID, err := parseAdminUserID(ctx.D["id"])
	if err != nil {
		return adminUserError(ctx, "INVALID_USER", "Invalid user ID")
	}

	var user models.User
	if err := db.Select("id", "login", "billing_id", "balance").First(&user, userID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return adminUserError(ctx, "USER_NOT_FOUND", "User not found")
		}
		return adminUserError(ctx, "NOK", "Cannot load user balance")
	}

	var ledger []models.BalanceTransaction
	if err := db.Where("user_id = ?", userID).
		Order("id DESC").
		Limit(100).
		Find(&ledger).Error; err != nil {
		return adminUserError(ctx, "NOK", "Cannot load balance transactions")
	}

	transactions := make([]map[string]any, 0, len(ledger))
	for _, item := range ledger {
		transactions = append(transactions, map[string]any{
			"id":            item.ID,
			"created_at":    item.CreatedAt,
			"type":          item.Type,
			"amount":        item.Amount,
			"balance_after": item.BalanceAfter,
		})
	}

	ctx.Out["user_id"] = user.ID
	ctx.Out["login"] = user.Login
	ctx.Out["balance"] = user.Balance
	ctx.Out["transactions"] = transactions
	return ctx.Out
}
