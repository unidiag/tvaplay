package main

import (
	"errors"
	"fmt"
	"main/models"
	"regexp"
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func apiAccountDevices(ctx *ApiCtx) map[string]any {
	out := ctx.Out

	// Get the account only from the authorized JWT.
	if ctx.User == nil {
		out["status"] = "UNAUTHORIZED"
		out["message"] = "Authorization required"
		return out
	}

	now := time.Now()

	var sessions []models.UserRefreshToken

	err := db.
		Where(
			"user_id = ? AND expires_at > ?",
			ctx.User.ID, now,
		).
		Order("created_at DESC, id DESC").
		Find(&sessions).Error

	if err != nil {
		out["status"] = "DB_ERROR"
		out["message"] = "Failed to retrieve devices"
		return out
	}

	devices := make([]map[string]any, 0, len(sessions))
	seen := make(map[string]bool)

	currentUID := strings.TrimSpace(ctx.D["uid"])

	for _, session := range sessions {
		uid := strings.TrimSpace(session.UID)

		if uid == "" || seen[uid] {
			continue
		}

		seen[uid] = true

		country := "?"
		if session.IP != "" {
			country = geoIP(session.IP)
			if country == "" {
				country = "?"
			}
		}

		devices = append(devices, map[string]any{
			"id":         session.ID,
			"uid":        uid,
			"ip":         session.IP,
			"country":    country,
			"user_agent": session.UserAgent,
			"created_at": session.CreatedAt.UTC().
				Format(time.RFC3339),
			"current": uid == currentUID,
		})
	}

	out["status"] = "OK"
	out["devices"] = devices
	out["count"] = len(devices)
	out["max_dev"] = userDeviceLimit(ctx.User.MaxDev)

	return out
}

func apiAccountDeviceRevoke(ctx *ApiCtx) map[string]any {
	out := ctx.Out

	if ctx.User == nil {
		out["status"] = "UNAUTHORIZED"
		out["message"] = "Authorization required"
		return out
	}

	id, err := strconv.ParseUint(
		strings.TrimSpace(ctx.D["id"]),
		10,
		64,
	)

	if err != nil || id == 0 {
		out["status"] = "INVALID_ID"
		out["message"] = "Invalid session ID"
		return out
	}

	userID := ctx.User.ID
	currentUID := strings.TrimSpace(ctx.D["uid"])

	var isCurrent bool
	var homeIP string
	var deleted int64

	err = db.WithContext(ctx.R.Context()).Transaction(
		func(tx *gorm.DB) error {

			// Блокируем пользователя, как в allowHomeIP().
			// Это исключает одновременную смену домашнего IP.
			var user models.User

			if err := tx.Clauses(
				clause.Locking{Strength: "UPDATE"},
			).
				First(&user, userID).Error; err != nil {
				return err
			}

			// Ищем только сессию данного пользователя.
			var session models.UserRefreshToken

			if err := tx.Clauses(
				clause.Locking{Strength: "UPDATE"},
			).
				Where(
					"id = ? AND user_id = ?",
					id,
					userID,
				).
				First(&session).Error; err != nil {
				return err
			}

			if session.UID == "" {
				return errors.New("INVALID_UID")
			}

			isCurrent = session.UID == currentUID

			// Если удаляем другое устройство,
			// определяем IP текущего HTTP-запроса.
			if !isCurrent {
				clientIP := getHLSClientIP(ctx.R)

				ip, err := normalizeHomeIP(clientIP)
				if err != nil {
					return errors.New("CLIENT_IP_UNAVAILABLE")
				}

				homeIP = ip
			}

			// Удаляем все refresh-сессии
			// выбранного устройства.
			result := tx.Where(
				"user_id = ? AND uid = ?",
				userID,
				session.UID,
			).Delete(&models.UserRefreshToken{})

			if result.Error != nil {
				return result.Error
			}

			deleted = result.RowsAffected

			// Удалено собственное устройство:
			// домашний IP оставляем без изменений.
			if isCurrent {
				return nil
			}

			// Удалено другое устройство:
			// немедленно переносим домашний IP
			// на адрес текущего устройства.
			now := time.Now().UTC()

			return tx.Model(&models.User{}).
				Where("id = ?", userID).
				UpdateColumns(map[string]any{
					"home_ip":            homeIP,
					"home_ip_seen_at":    now,
					"home_ip_changed_at": now,
				}).Error
		},
	)

	if err != nil {
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			out["status"] = "NOT_FOUND"
			out["message"] = "Session not found"

		case err.Error() == "INVALID_UID":
			out["status"] = "INVALID_UID"
			out["message"] = "Invalid session UID"

		case err.Error() == "CLIENT_IP_UNAVAILABLE":
			out["status"] = "CLIENT_IP_UNAVAILABLE"
			out["message"] = "Cannot determine client IP"

		default:
			out["status"] = "DB_ERROR"
			out["message"] = "Failed to revoke session"
		}

		return out
	}

	out["status"] = "OK"
	out["message"] = "Session revoked"
	out["current"] = isCurrent
	out["deleted_sessions"] = deleted
	out["home_ip_changed"] = !isCurrent

	if !isCurrent {
		out["home_ip"] = homeIP
	}

	return out
}

func apiAccountInfo(ctx *ApiCtx) map[string]any {
	out := ctx.Out

	if ctx.User == nil {
		out["status"] = "UNAUTHORIZED"
		out["message"] = "Authorization required"
		return out
	}

	query := db.WithContext(ctx.R.Context())

	var user models.User

	if err := query.First(&user, ctx.User.ID).Error; err != nil {
		out["status"] = "DB_ERROR"
		out["message"] = "Failed to load account"
		return out
	}

	location, err := billingLocation()
	if err != nil {
		out["status"] = "INTERNAL_ERROR"
		out["message"] = "Billing timezone unavailable"
		return out
	}

	pauseAvailable := canPauseAccount(
		&user,
		time.Now(),
		location,
	)

	pauseNextDate := ""

	if user.LastPausedAt != nil {
		next := nextAccountPauseDate(
			*user.LastPausedAt,
			location,
		)

		// Формат сразу готов для отображения в TV UI.
		pauseNextDate = next.Format("02.01.2006")
	}

	// Получаем все пакеты, назначенные абоненту.
	var links []models.UserPackage

	if err := query.
		Where("user_id = ?", user.ID).
		Find(&links).Error; err != nil {
		out["status"] = "DB_ERROR"
		out["message"] = "Failed to load subscriptions"
		return out
	}

	selected := make(map[uint32]bool, len(links))
	disableDates := make(map[uint32]string, len(links))

	now := time.Now().UTC()

	for _, link := range links {
		selected[link.PackageID] = true

		availableAt := packageDisableAvailableAt(
			link.EnabledAt,
		)

		if availableAt != nil && now.Before(*availableAt) {
			disableDates[link.PackageID] = availableAt.
				In(location).
				Format("02.01.2006 15:04")
		}
	}

	// Показываем включённые пакеты каталога.
	var allPackages []models.Package

	if err := query.
		Where("enabled = ?", 1).
		Order("position ASC, id ASC").
		Find(&allPackages).Error; err != nil {
		out["status"] = "DB_ERROR"
		out["message"] = "Failed to load packages"
		return out
	}

	packages := make([]map[string]any, 0, len(allPackages))

	for _, pkg := range allPackages {
		isSelected := selected[pkg.ID]

		// Обычный пакет показываем только при подключении.
		// Опциональный показываем независимо от подключения.
		if !pkg.Optional && !isSelected {
			continue
		}

		channelCount := query.Model(&pkg).
			Association("Channels").
			Count()

		packages = append(packages, map[string]any{
			"id":                   pkg.ID,
			"name":                 pkg.Name,
			"monthly_price":        pkg.MonthlyPrice,
			"optional":             pkg.Optional,
			"selected":             isSelected,
			"channel_count":        channelCount,
			"disable_available_at": disableDates[pkg.ID],
		})
	}

	// Рассчитываем ежедневную абонентскую плату
	// по той же формуле, что и billing.go.

	location, err = billingLocation()
	if err != nil {
		out["status"] = "INTERNAL_ERROR"
		out["message"] = "Billing timezone unavailable"
		return out
	}

	if user.LastPausedAt != nil {
		next := nextAccountPauseDate(
			*user.LastPausedAt,
			location,
		)

		// Формат сразу готов для отображения в TV UI.
		pauseNextDate = next.Format("02.01.2006")
	}

	day := billingDay(time.Now(), location)
	days := billingDaysInMonth(day)
	index := day.Day()

	// Скидка применяется только для статуса 2.
	discount, err := billingDiscount()
	if err != nil {
		out["status"] = "CONFIG_ERROR"
		out["message"] = "Invalid billing discount"
		return out
	}

	userDiscount := 0
	if user.Status == 2 {
		userDiscount = discount
	}

	var daily struct {
		Amount string `gorm:"column:amount"`
	}

	err = query.Raw(`
SELECT
    CAST(
        CASE
            WHEN ? = 0 THEN 0.00
            ELSE
                ROUND(discounted_total * ? / ?, 2) -
                ROUND(discounted_total * ? / ?, 2)
        END
        AS CHAR
    ) AS amount
FROM (
    SELECT
        CAST(
            ROUND(
                COALESCE(SUM(p.monthly_price), 0) *
                (100 - ?) / 100,
                2
            )
            AS DECIMAL(12,2)
        ) AS discounted_total
    FROM user_packages up
    JOIN packages p ON p.id = up.package_id
    WHERE up.user_id = ?
      AND p.enabled = 1
) AS totals`,
		user.Status,
		index,
		days,
		index-1,
		days,
		userDiscount,
		user.ID,
	).Scan(&daily).Error

	if err != nil {
		out["status"] = "DB_ERROR"
		out["message"] = "Failed to calculate daily charge"
		return out
	}

	if strings.TrimSpace(daily.Amount) == "" {
		out["status"] = "DB_ERROR"
		out["message"] = "Invalid daily charge"
		return out
	}

	out["phone"] = formatAccountPhone(
		user.Login,
		getSetting("phone_regex"),
	)
	out["info"] = user.Info
	out["balance"] = user.Balance
	out["billing_id"] = user.BillingID
	out["currency"] = getSetting("currency")
	out["user_status"] = user.Status
	out["discount"] = getSetting("discount")
	out["pause_available"] = pauseAvailable
	out["pause_next_date"] = pauseNextDate
	out["daily_charge"] = daily.Amount
	out["packages"] = packages
	out["copyright"] = getSetting("copyright")

	return out
}

func nextAccountPauseDate(
	lastPausedAt time.Time,
	location *time.Location,
) time.Time {
	last := lastPausedAt.In(location)

	// Первое число следующего месяца.
	first := time.Date(
		last.Year(),
		last.Month()+1,
		1, 0, 0, 0, 0,
		location,
	)

	// Если исходная дата 31-е, а в следующем
	// месяце меньше дней, используем последний
	// день следующего месяца.
	day := last.Day()
	maxDay := billingDaysInMonth(first)

	if day > maxDay {
		day = maxDay
	}

	return time.Date(
		first.Year(),
		first.Month(),
		day, 0, 0, 0, 0,
		location,
	)
}

func canPauseAccount(
	user *models.User,
	now time.Time,
	location *time.Location,
) bool {
	if user == nil || user.Status != 1 {
		return false
	}

	if user.LastPausedAt == nil {
		return true
	}

	next := nextAccountPauseDate(
		*user.LastPausedAt,
		location,
	)

	return !billingDay(now, location).Before(next)
}

var (
	errAccountPauseLimit = errors.New(
		"monthly pause limit reached",
	)
	errAccountStatusChanged = errors.New(
		"account status changed",
	)
	errAccountInsufficientBalance = errors.New(
		"positive balance required to pause subscription",
	)
	pauseTaxRegexp = regexp.MustCompile(
		`^(?:0|[1-9][0-9]{0,9})\.[0-9]{2}$`,
	)
)

func apiAccountPauseToggle(ctx *ApiCtx) map[string]any {
	out := ctx.Out

	if ctx.User == nil {
		out["status"] = "UNAUTHORIZED"
		out["message"] = "Authorization required"
		return out
	}

	action := strings.TrimSpace(ctx.D["action"])

	if action != "pause" && action != "resume" {
		out["status"] = "INVALID_ACTION"
		out["message"] = "Invalid account action"
		return out
	}

	// Стоимость изменения статуса подписки.
	// Получаем настройку до открытия транзакции.
	pauseTax := "0.00"
	resumeTax := "0.00"

	if action == "pause" {
		pauseTax = strings.TrimSpace(
			getSetting("pause_tax"),
		)

		if !pauseTaxRegexp.MatchString(pauseTax) {
			out["status"] = "CONFIG_ERROR"
			out["message"] = "Invalid pause tax"
			return out
		}
	}

	if action == "resume" {
		resumeTax = strings.TrimSpace(
			getSetting("resume_tax"),
		)

		if !pauseTaxRegexp.MatchString(resumeTax) {
			out["status"] = "CONFIG_ERROR"
			out["message"] = "Invalid resume tax"
			return out
		}
	}

	location, err := billingLocation()
	if err != nil {
		out["status"] = "INTERNAL_ERROR"
		out["message"] = "Billing timezone unavailable"
		return out
	}

	now := time.Now().UTC()
	var nextStatus uint
	var nextPauseAvailable bool

	// Транзакция не позволяет двум параллельным
	// запросам одновременно использовать лимит.
	err = db.WithContext(ctx.R.Context()).Transaction(
		func(tx *gorm.DB) error {
			var user models.User

			// Блокируем конкретную запись абонента.
			if err := tx.Clauses(
				clause.Locking{Strength: "UPDATE"},
			).First(&user, ctx.User.ID).Error; err != nil {
				return err
			}

			switch action {

			case "pause":
				// Постановка на паузу разрешена
				// только активному абоненту.
				if user.Status != 1 {
					return errAccountStatusChanged
				}

				// Проверяем месячный лимит паузы.
				if !canPauseAccount(&user, now, location) {
					return errAccountPauseLimit
				}

				// Списываем стоимость паузы,
				// меняем статус и сохраняем дату.
				//
				// Арифметика выполняется в MySQL
				// с точностью DECIMAL(12,2).
				//
				// Баланс должен быть положительным
				// и достаточным для оплаты pause_tax.
				result := tx.Model(&user).
					Where(
						"status = ? AND balance > 0 "+
							"AND balance >= CAST(? AS DECIMAL(12,2))",
						1,
						pauseTax,
					).
					Updates(map[string]any{
						"status":         0,
						"last_paused_at": now,
						"balance": gorm.Expr(
							"balance - CAST(? AS DECIMAL(12,2))",
							pauseTax,
						),
					})

				if result.Error != nil {
					return result.Error
				}

				if result.RowsAffected != 1 {
					return errAccountInsufficientBalance
				}

				// Получаем фактический остаток
				// после списания в той же транзакции.
				var balanceAfter struct {
					Value string `gorm:"column:balance"`
				}

				read := tx.Raw(
					"SELECT CAST(balance AS CHAR) AS balance "+
						"FROM users WHERE id = ?",
					user.ID,
				).Scan(&balanceAfter)

				if read.Error != nil {
					return read.Error
				}

				if read.RowsAffected != 1 ||
					strings.TrimSpace(balanceAfter.Value) == "" {
					return fmt.Errorf(
						"invalid balance after pause: user_id=%d",
						user.ID,
					)
				}

				// Уникальный ключ конкретной постановки на паузу.
				// Используем user.ID и время в наносекундах.
				//
				// Повторная постановка на паузу невозможна,
				// пока статус пользователя равен 0.
				operationKey := fmt.Sprintf(
					"pause:%d:%d",
					user.ID,
					now.UnixNano(),
				)

				// Сумма списания записывается со знаком минус.
				// При pause_tax = 1.00 получим -1.00.
				ledger := models.BalanceTransaction{
					UserID:       user.ID,
					Type:         models.BalancePauseFee,
					Amount:       "-" + pauseTax,
					BalanceAfter: &balanceAfter.Value,
					OperationKey: operationKey,
				}

				// Создаём запись в универсальном журнале
				// движений по балансу.
				//
				// Если запись не создастся,
				// транзакция откатит и списание,
				// и изменение статуса.
				if err := tx.Create(&ledger).Error; err != nil {
					return fmt.Errorf(
						"save pause transaction user_id=%d: %w",
						user.ID,
						err,
					)
				}

				nextStatus = 0
				nextPauseAvailable = false

			case "resume":
				// Возобновить вещание может только
				// абонент со статусом 0.
				if user.Status != 0 {
					return errAccountStatusChanged
				}

				// При возобновлении не изменяем
				// last_paused_at — он используется
				// для месячного ограничения паузы.

				// Проверяем необходимость списания.
				// Валидация resumeTax выполнена
				// перед началом транзакции.
				paidResume := resumeTax != "0.00"

				// Обновляем пользователя.
				// Используем SQL-арифметику DECIMAL(12,2).
				updates := map[string]any{
					"status": 1,
				}

				if paidResume {
					updates["balance"] = gorm.Expr(
						"balance - CAST(? AS DECIMAL(12,2))",
						resumeTax,
					)
				}

				query := tx.Model(&user).
					Where("status = ?", 0)

				// При платном возобновлении
				// денег должно хватать на оплату.
				//
				// Для бесплатного возобновления
				// ограничений по балансу нет.
				if paidResume {
					query = query.Where(
						"balance >= CAST(? AS DECIMAL(12,2))",
						resumeTax,
					)
				}

				result := query.Updates(updates)

				if result.Error != nil {
					return result.Error
				}

				if result.RowsAffected != 1 {
					if paidResume {
						return errAccountInsufficientBalance
					}

					return errAccountStatusChanged
				}

				// Фиксируем каждое возобновление вещания,
				// в том числе бесплатное.

				var balanceAfter struct {
					Value string `gorm:"column:balance"`
				}

				read := tx.Raw(
					"SELECT CAST(balance AS CHAR) AS balance "+
						"FROM users WHERE id = ?",
					user.ID,
				).Scan(&balanceAfter)

				if read.Error != nil {
					return read.Error
				}

				if read.RowsAffected != 1 ||
					strings.TrimSpace(balanceAfter.Value) == "" {
					return fmt.Errorf(
						"invalid balance after resume: user_id=%d",
						user.ID,
					)
				}

				// Сумма операции:
				// 0.00 — бесплатное возобновление;
				// -2.00 — списание 2 рублей.
				amount := "0.00"

				if paidResume {
					amount = "-" + resumeTax
				}

				operationKey := fmt.Sprintf(
					"resume:%d:%d",
					user.ID,
					now.UnixNano(),
				)

				ledger := models.BalanceTransaction{
					UserID:       user.ID,
					Type:         models.BalanceResumeFee,
					Amount:       amount,
					BalanceAfter: &balanceAfter.Value,
					OperationKey: operationKey,
				}

				if err := tx.Create(&ledger).Error; err != nil {
					return fmt.Errorf(
						"save resume transaction user_id=%d: %w",
						user.ID,
						err,
					)
				}

				// Возврат стоимости паузы при возобновлении
				// в пределах того же календарного дня.
				if user.LastPausedAt != nil &&
					billingDay(*user.LastPausedAt, location).Equal(
						billingDay(now, location),
					) {

					// Находим фактическое списание за последнюю паузу.
					var pauseOperation models.BalanceTransaction

					pauseKeyPrefix := fmt.Sprintf(
						"pause:%d:%%",
						user.ID,
					)

					err := tx.
						Where(
							"user_id = ? AND type = ? AND operation_key LIKE ?",
							user.ID,
							models.BalancePauseFee,
							pauseKeyPrefix,
						).
						Order("id DESC").
						First(&pauseOperation).Error

					if err != nil {
						return fmt.Errorf(
							"find pause fee for refund user_id=%d: %w",
							user.ID,
							err,
						)
					}

					// Проверяем, что операция соответствует текущей паузе.
					// Допуск 1 секунда учитывает точность даты в БД.
					delta := pauseOperation.CreatedAt.Sub(*user.LastPausedAt)

					if delta < -time.Second || delta > time.Second {
						return fmt.Errorf(
							"pause fee does not match current pause user_id=%d",
							user.ID,
						)
					}

					// Оригинальная операция содержит отрицательную сумму.
					// Например: -1.50 -> 1.50.
					refundAmount := strings.TrimPrefix(
						pauseOperation.Amount,
						"-",
					)

					if !strings.HasPrefix(pauseOperation.Amount, "-") ||
						!pauseTaxRegexp.MatchString(refundAmount) {
						return fmt.Errorf(
							"invalid pause fee for refund user_id=%d",
							user.ID,
						)
					}

					if refundAmount != "0.00" {
						// Уникальный ключ привязан к исходному списанию.
						// Повторный возврат той же операции невозможен.
						refundKey := fmt.Sprintf(
							"pause_refund:%d",
							pauseOperation.ID,
						)

						// Возвращаем деньги через DECIMAL-арифметику MySQL.
						result := tx.Model(&user).Update(
							"balance",
							gorm.Expr(
								"balance + CAST(? AS DECIMAL(12,2))",
								refundAmount,
							),
						)

						if result.Error != nil {
							return result.Error
						}

						var afterRefund struct {
							Value string `gorm:"column:balance"`
						}

						read := tx.Raw(
							"SELECT CAST(balance AS CHAR) AS balance "+
								"FROM users WHERE id = ?",
							user.ID,
						).Scan(&afterRefund)

						if read.Error != nil {
							return read.Error
						}

						if read.RowsAffected != 1 ||
							afterRefund.Value == "" {
							return fmt.Errorf(
								"invalid balance after refund user_id=%d",
								user.ID,
							)
						}

						refund := models.BalanceTransaction{
							UserID:       user.ID,
							Type:         models.BalancePauseRefund,
							Amount:       refundAmount,
							BalanceAfter: &afterRefund.Value,
							OperationKey: refundKey,
						}

						if err := tx.Create(&refund).Error; err != nil {
							return fmt.Errorf(
								"save pause refund user_id=%d: %w",
								user.ID,
								err,
							)
						}
					}
				}

				// Обновляем локальную модель,
				// чтобы canPauseAccount() использовала
				// актуальный статус.
				user.Status = 1

				nextStatus = 1
				nextPauseAvailable = canPauseAccount(
					&user,
					now,
					location,
				)

			}

			return nil
		},
	)

	if err != nil {
		switch {
		case errors.Is(err, errAccountPauseLimit):
			out["status"] = "PAUSE_LIMIT"
			out["message"] = "Monthly pause limit reached"

			// Получаем актуальную дату из БД.
			var current models.User

			if loadErr := db.WithContext(ctx.R.Context()).
				First(&current, ctx.User.ID).Error; loadErr == nil &&
				current.LastPausedAt != nil {

				out["pause_next_date"] = nextAccountPauseDate(
					*current.LastPausedAt,
					location,
				).Format("02.01.2006")
			}

		case errors.Is(err, errAccountStatusChanged):
			out["status"] = "STATUS_CHANGED"
			out["message"] = "Account status has changed"

		case errors.Is(err, gorm.ErrRecordNotFound):
			out["status"] = "NOT_FOUND"
			out["message"] = "Account not found"

		case errors.Is(err, errAccountInsufficientBalance):
			out["status"] = "INSUFFICIENT_BALANCE"
			out["message"] = "Insufficient balance"

			if action == "pause" {
				out["message"] = "Insufficient balance to pause subscription"
			} else {
				out["message"] = "Insufficient balance to resume subscription"
			}

		default:
			out["status"] = "DB_ERROR"
			out["message"] = "Failed to update account"
		}

		return out
	}

	out["status"] = "OK"
	out["user_status"] = nextStatus
	out["pause_available"] = nextPauseAvailable

	return out
}

// apiAccountTransactions возвращает последние
// 10 движений баланса текущего абонента.
func apiAccountTransactions(ctx *ApiCtx) map[string]any {
	out := ctx.Out

	if ctx.User == nil {
		out["status"] = "UNAUTHORIZED"
		out["message"] = "Authorization required"
		return out
	}

	type Transaction struct {
		ID        uint64    `json:"id"`
		Type      string    `json:"type"`
		Amount    string    `json:"amount"`
		CreatedAt time.Time `json:"created_at"`
	}

	transactions := make([]Transaction, 0, 10)

	err := db.WithContext(ctx.R.Context()).
		Model(&models.BalanceTransaction{}).
		Select(
			"id",
			"type",
			"amount",
			"created_at",
		).
		Where("user_id = ?", ctx.User.ID).
		Order("created_at DESC, id DESC").
		Limit(10).
		Find(&transactions).Error

	if err != nil {
		out["status"] = "DB_ERROR"
		out["message"] = "Failed to load balance transactions"
		return out
	}

	out["status"] = "OK"
	out["transactions"] = transactions

	return out
}
