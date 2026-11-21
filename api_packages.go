package main

import (
	"errors"
	"fmt"
	"main/models"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var packageCodePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
var packagePricePattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$`)

var errPackageDisableLimit = errors.New(
	"package cannot be disabled within 24 hours",
)

const packageMinimumDuration = 24 * time.Hour

func packageDisableAvailableAt(
	enabledAt *time.Time,
) *time.Time {
	if enabledAt == nil {
		// Старое подключение без даты:
		// отключение разрешено.
		return nil
	}

	availableAt := enabledAt.Add(packageMinimumDuration)
	return &availableAt
}

func packageAPIError(ctx *ApiCtx, message string) map[string]any {
	ctx.Out["status"] = "NOK"
	ctx.Out["message"] = message
	return ctx.Out
}

func packageID(text string) (uint32, error) {
	n, err := strconv.ParseUint(strings.TrimSpace(text), 10, 32)
	if err != nil || n == 0 {
		return 0, errors.New("Invalid package ID")
	}
	return uint32(n), nil
}

func packageChannelIDs(value any) ([]uint32, error) {
	raw, ok := value.([]any)
	if !ok || len(raw) > 65535 {
		return nil, errors.New("Invalid channels list")
	}
	ids := make([]uint32, 0, len(raw))
	used := map[uint32]bool{}
	for _, v := range raw {
		var n uint64
		switch x := v.(type) {
		case float64:
			if x < 1 || x > 4294967295 || x != float64(uint64(x)) {
				return nil, errors.New("Invalid channel ID")
			}
			n = uint64(x)
		case string:
			parsed, err := strconv.ParseUint(x, 10, 32)
			if err != nil {
				return nil, errors.New("Invalid channel ID")
			}
			n = parsed
		default:
			return nil, errors.New("Invalid channel ID")
		}
		if n == 0 || used[uint32(n)] {
			return nil, errors.New("Duplicate or invalid channel ID")
		}
		used[uint32(n)] = true
		ids = append(ids, uint32(n))
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids, nil
}

type adminPackageRow struct {
	models.Package
	ChannelIDs   []uint32 `json:"channel_ids"`
	ChannelCount int      `json:"channel_count"`
}

func apiAdminPackages(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}
	var pkgs []models.Package
	if err := db.Order("position ASC, id ASC").Find(&pkgs).Error; err != nil {
		return packageAPIError(ctx, "Cannot load packages")
	}
	var links []models.ChannelPackage
	if err := db.Find(&links).Error; err != nil {
		return packageAPIError(ctx, "Cannot load package channels")
	}
	byPackage := map[uint32][]uint32{}
	for _, link := range links {
		byPackage[link.PackageID] = append(byPackage[link.PackageID], link.ChannelID)
	}
	rows := make([]adminPackageRow, 0, len(pkgs))
	for _, pkg := range pkgs {
		ids := byPackage[pkg.ID]
		if ids == nil {
			ids = []uint32{}
		}
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
		pkg.Channels = nil
		rows = append(rows, adminPackageRow{Package: pkg, ChannelIDs: ids, ChannelCount: len(ids)})
	}
	ctx.Out["packages"] = rows
	return ctx.Out
}

func apiAdminPackageSave(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}
	name := strings.TrimSpace(ctx.D["name"])
	code := strings.ToLower(strings.TrimSpace(ctx.D["code"]))
	description := strings.TrimSpace(ctx.D["description"])
	monthlyPrice := strings.TrimSpace(ctx.D["monthly_price"])
	if monthlyPrice == "" {
		monthlyPrice = "0"
	}
	if !packagePricePattern.MatchString(monthlyPrice) {
		return packageAPIError(ctx, "Monthly price must be between 0.00 and 99999999.99 with up to 2 decimal places")
	}
	parts := strings.SplitN(monthlyPrice, ".", 2)
	if len(parts) == 1 {
		monthlyPrice += ".00"
	} else if len(parts[1]) == 1 {
		monthlyPrice += "0"
	}
	if name == "" || len(name) > 255 {
		return packageAPIError(ctx, "Package name must contain 1–255 characters")
	}
	if !packageCodePattern.MatchString(code) {
		return packageAPIError(ctx, "Code must contain only lowercase letters, digits, underscore or dash")
	}
	if len(description) > 10000 {
		return packageAPIError(ctx, "Description is too long")
	}
	enabled, err := strconv.ParseUint(ctx.D["enabled"], 10, 8)
	if err != nil || enabled > 1 {
		return packageAPIError(ctx, "Invalid enabled value")
	}
	// Optional permits the subscriber to manage this package in their own panel.
	// The missing field defaults to false for backward compatibility.
	optional := false
	switch strings.ToLower(strings.TrimSpace(ctx.D["optional"])) {
	case "", "0", "false":
		optional = false
	case "1", "true":
		optional = true
	default:
		return packageAPIError(ctx, "Invalid optional value")
	}
	// ForNew attaches the package automatically to new subscribers.
	// Accept omitted values from older admin clients as false.
	forNew := false
	switch strings.ToLower(strings.TrimSpace(ctx.D["for_new"])) {
	case "", "0", "false":
		forNew = false
	case "1", "true":
		forNew = true
	default:
		return packageAPIError(ctx, "Invalid for_new value")
	}
	pos, err := strconv.ParseUint(ctx.D["position"], 10, 16)
	if err != nil {
		return packageAPIError(ctx, "Invalid position")
	}
	var id uint32
	if x := strings.TrimSpace(ctx.D["id"]); x != "" && x != "0" {
		id, err = packageID(x)
		if err != nil {
			return packageAPIError(ctx, "Invalid package ID")
		}
	}
	// Channels must always be supplied, including [] for an empty package.
	ids, err := packageChannelIDs(ctx.Data["channel_ids"])
	if err != nil {
		return packageAPIError(ctx, err.Error())
	}
	var saved models.Package
	err = db.Transaction(func(tx *gorm.DB) error {
		if len(ids) > 0 {
			var count int64
			if err := tx.Model(&models.Channel{}).Where("id IN ?", ids).Count(&count).Error; err != nil {
				return err
			}
			if count != int64(len(ids)) {
				return errors.New("One or more channels do not exist")
			}
		}
		if id > 0 {
			if err := tx.First(&saved, id).Error; err != nil {
				return err
			}
			if err := tx.Model(&saved).Updates(map[string]any{
				"name": name, "code": code, "description": description,
				"position": uint16(pos), "enabled": uint8(enabled),
				"monthly_price": monthlyPrice, "optional": optional, "for_new": forNew,
			}).Error; err != nil {
				return err
			}
		} else {
			saved = models.Package{Name: name, Code: code, Description: description, Position: uint16(pos), Enabled: uint8(enabled), MonthlyPrice: monthlyPrice, Optional: optional, ForNew: forNew}
			if err := tx.Create(&saved).Error; err != nil {
				return err
			}
		}
		if err := tx.Where("package_id = ?", saved.ID).Delete(&models.ChannelPackage{}).Error; err != nil {
			return err
		}
		links := make([]models.ChannelPackage, 0, len(ids))
		for _, channelID := range ids {
			links = append(links, models.ChannelPackage{PackageID: saved.ID, ChannelID: channelID})
		}
		if len(links) > 0 {
			return tx.Create(&links).Error
		}
		return nil
	})
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return packageAPIError(ctx, "Package not found")
	}
	if err != nil {
		return packageAPIError(ctx, fmt.Sprintf("Cannot save package: %v", err))
	}
	ctx.Out["id"] = saved.ID
	return ctx.Out
}

func apiAdminPackageDelete(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}
	id, err := packageID(ctx.D["id"])
	if err != nil {
		return packageAPIError(ctx, "Invalid package ID")
	}
	err = db.Transaction(func(tx *gorm.DB) error {
		var pkg models.Package
		if err := tx.First(&pkg, id).Error; err != nil {
			return err
		}
		if err := tx.Where("package_id = ?", id).Delete(&models.ChannelPackage{}).Error; err != nil {
			return err
		}
		return tx.Delete(&pkg).Error
	})
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return packageAPIError(ctx, "Package not found")
	}
	if err != nil {
		return packageAPIError(ctx, "Cannot delete package")
	}
	return ctx.Out
}

// assignForNewPackages is called exactly once when a new User is created.
// It runs inside the caller's transaction so partial registration is impossible.
// Only enabled packages marked for automatic enrollment are selected.
func assignForNewPackages(tx *gorm.DB, userID uint) error {
	var packageIDs []uint32
	if err := tx.Model(&models.Package{}).
		Where("enabled = ? AND for_new = ?", 1, true).
		Pluck("id", &packageIDs).Error; err != nil {
		return err
	}
	if len(packageIDs) == 0 {
		return nil
	}
	links := make([]models.UserPackage, 0, len(packageIDs))
	for _, id := range packageIDs {
		links = append(links, models.UserPackage{UserID: userID, PackageID: id})
	}
	return tx.Create(&links).Error
}

func apiAccountPackageToggle(ctx *ApiCtx) map[string]any {
	out := ctx.Out

	if ctx.User == nil {
		out["status"] = "UNAUTHORIZED"
		out["message"] = "Authorization required"
		return out
	}

	// Проверяем ID пакета.
	id, err := strconv.ParseUint(
		strings.TrimSpace(ctx.D["package_id"]),
		10,
		32,
	)

	if err != nil || id == 0 {
		out["status"] = "INVALID_PACKAGE"
		out["message"] = "Invalid package ID"
		return out
	}

	// Явно требуем 0 или 1.
	enabledText := strings.TrimSpace(ctx.D["enabled"])

	if enabledText != "0" && enabledText != "1" {
		out["status"] = "INVALID_VALUE"
		out["message"] = "Invalid subscription value"
		return out
	}

	enable := enabledText == "1"
	packageID := uint32(id)
	userID := ctx.User.ID

	errNotOptional := errors.New("PACKAGE_NOT_OPTIONAL")
	errDisabled := errors.New("PACKAGE_DISABLED")

	// Дата, когда можно будет отключить пакет.
	var disableAvailableAt *time.Time

	// Транзакция защищает операцию от повторных запросов
	// и обеспечивает согласованное изменение подписки.
	err = db.WithContext(ctx.R.Context()).Transaction(
		func(tx *gorm.DB) error {

			// Сериализуем изменения пакетов одного абонента.
			var user models.User

			if err := tx.Clauses(
				clause.Locking{Strength: "UPDATE"},
			).First(&user, userID).Error; err != nil {
				return err
			}

			// Получаем пакет из БД.
			// Не доверяем полю optional от клиента.
			var pkg models.Package

			if err := tx.Clauses(
				clause.Locking{Strength: "UPDATE"},
			).First(&pkg, packageID).Error; err != nil {
				return err
			}

			if !pkg.Optional {
				return errNotOptional
			}

			if pkg.Enabled != 1 {
				return errDisabled
			}

			// Текущее время в UTC.
			now := time.Now().UTC()

			if enable {
				// Подключение пакета разрешено в любой момент.
				// Фиксируем начало 24-часового периода.
				link := models.UserPackage{
					UserID:    userID,
					PackageID: packageID,
					EnabledAt: &now,
				}

				// Если пакет уже подключён, повторный запрос
				// не изменяет время первоначального подключения.
				return tx.Clauses(
					clause.OnConflict{DoNothing: true},
				).Create(&link).Error
			}

			// Отключение пакета.
			// Сначала загружаем существующую связь.
			var link models.UserPackage

			err := tx.Where(
				"user_id = ? AND package_id = ?",
				userID,
				packageID,
			).First(&link).Error

			if errors.Is(err, gorm.ErrRecordNotFound) {
				// Пакет уже отключён.
				// Повторное отключение считаем успешным.
				return nil
			}

			if err != nil {
				return err
			}

			// Проверяем, прошли ли 24 часа
			// с момента подключения.
			availableAt := packageDisableAvailableAt(
				link.EnabledAt,
			)

			if availableAt != nil &&
				now.Before(*availableAt) {

				// Сохраняем время для ответа API.
				disableAvailableAt = availableAt

				// Ничего не удаляем.
				return errPackageDisableLimit
			}

			// 24 часа прошли (либо старое подключение
			// не содержит даты EnabledAt).
			// Удаляем связь абонента с пакетом.
			return tx.Where(
				"user_id = ? AND package_id = ?",
				userID,
				packageID,
			).Delete(&models.UserPackage{}).Error
		},
	)

	if err != nil {
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			out["status"] = "NOT_FOUND"
			out["message"] = "User or package not found"

		case errors.Is(err, errNotOptional):
			out["status"] = "FORBIDDEN"
			out["message"] = "Package is not optional"

		case errors.Is(err, errDisabled):
			out["status"] = "PACKAGE_DISABLED"
			out["message"] = "Package is disabled"

		case errors.Is(err, errPackageDisableLimit):
			out["status"] = "PACKAGE_DISABLE_LIMIT"
			out["message"] = "Package cannot be disabled yet"

			if disableAvailableAt != nil {
				location, locErr := billingLocation()
				if locErr == nil {
					out["disable_available_at"] =
						disableAvailableAt.In(location).
							Format("02.01.2006 15:04")
				}
			}

		default:
			out["status"] = "DB_ERROR"
			out["message"] = "Failed to update subscription"
		}

		return out
	}

	out["selected"] = enable
	out["package_id"] = packageID

	return out
}
