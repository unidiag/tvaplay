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

	"gorm.io/gorm"
)

// Keep administrative responses limited to profile fields. In particular,
// never serialize password, SMS codes, refresh tokens or other auth secrets.
type adminUserRow struct {
	ID         uint     `json:"id"`
	Login      string   `json:"login"`
	Status     uint     `json:"status"`
	MaxDev     uint     `json:"max_dev"`
	Info       string   `json:"info"`
	Balance    string   `json:"balance"`
	LastActive any      `json:"last_active"`
	LastIP     string   `json:"last_ip"`
	LoginAt    any      `json:"login_at"`
	CreatedAt  any      `json:"created_at"`
	UpdatedAt  any      `json:"updated_at"`
	PackageIDs []uint32 `json:"package_ids"`
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
			ID: user.ID, Login: user.Login, Status: user.Status,
			MaxDev: user.MaxDev, Info: user.Info, Balance: user.Balance, LastActive: user.LastActive,
			LastIP: user.LastIP, LoginAt: user.LoginAt,
			CreatedAt: user.CreatedAt, UpdatedAt: user.UpdatedAt,
			PackageIDs: ids,
		})
	}
	ctx.Out["users"] = rows
	if ctx.User != nil {
		ctx.Out["current_user_status"] = ctx.User.Status
	}
	return ctx.Out
}

// POST {"op":"adminUserSave","id":1,"login":"+375...","status":1,"max_dev":2,"package_ids":[1,2]}
func apiAdminUserSave(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}
	id, err := parseAdminUserID(ctx.D["id"])
	if err != nil {
		return adminUserError(ctx, "INVALID_USER", "Invalid user ID")
	}
	login := strings.TrimSpace(ctx.D["login"])
	if login == "" || len(login) > 15 {
		return adminUserError(ctx, "INVALID_LOGIN", "Login must be 1–15 characters")
	}
	status, err := strconv.ParseUint(strings.TrimSpace(ctx.D["status"]), 10, 32)
	if err != nil {
		return adminUserError(ctx, "INVALID_STATUS", "Invalid user status")
	}
	// Keep existing status semantics. Allow currently supported values only.
	switch status {
	case 0, 1, 2, 8, 9:
	default:
		return adminUserError(ctx, "INVALID_STATUS", "Unsupported user status")
	}
	maxDev, err := strconv.ParseUint(strings.TrimSpace(ctx.D["max_dev"]), 10, 32)
	if err != nil || maxDev < 1 || maxDev > 1000 {
		return adminUserError(ctx, "INVALID_MAX_DEV", "Max devices must be between 1 and 1000")
	}
	info := ctx.D["info"]
	if len([]rune(info)) > 10000 {
		return adminUserError(ctx, "INVALID_INFO", "Info must not exceed 10000 characters")
	}
	balance, err := parseAdminBalance(ctx.D["balance"])
	if err != nil {
		return adminUserError(ctx, "INVALID_BALANCE", err.Error())
	}
	ids, err := parseAdminPackageIDs(ctx.Data["package_ids"])
	if err != nil {
		return adminUserError(ctx, "INVALID_PACKAGES", err.Error())
	}
	// Prevent administrators from accidentally locking themselves out.
	if ctx.User != nil && ctx.User.ID == id && status < 8 {
		return adminUserError(ctx, "INVALID_STATUS", "You cannot remove your own administrator access")
	}
	err = db.Transaction(func(tx *gorm.DB) error {
		var user models.User
		if err := tx.First(&user, id).Error; err != nil {
			return err
		}
		// Only status 9 may change user status or financial balance.
		// Compare against the fresh record inside the transaction.
		if ctx.User == nil || ctx.User.Status != 9 {
			if status != uint64(user.Status) {
				return errors.New("FORBIDDEN_STATUS_CHANGE")
			}
			if !equalAdminBalances(balance, user.Balance) {
				return errors.New("FORBIDDEN_BALANCE_CHANGE")
			}
		}
		if len(ids) > 0 {
			var count int64
			if err := tx.Model(&models.Package{}).Where("id IN ?", ids).Count(&count).Error; err != nil {
				return err
			}
			if count != int64(len(ids)) {
				return errors.New("One or more packages no longer exist")
			}
		}
		updates := map[string]any{
			"login":   login,
			"max_dev": uint(maxDev),
			"info":    info,
		}
		if ctx.User != nil && ctx.User.Status == 9 {
			updates["status"] = uint(status)
			updates["balance"] = balance
		}
		if err := tx.Model(&user).Updates(updates).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&models.UserPackage{}).Error; err != nil {
			return err
		}
		if len(ids) > 0 {
			links := make([]models.UserPackage, 0, len(ids))
			for _, pkgID := range ids {
				links = append(links, models.UserPackage{UserID: id, PackageID: pkgID})
			}
			if err := tx.Create(&links).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil && err.Error() == "FORBIDDEN_STATUS_CHANGE" {
		return adminUserError(ctx, "FORBIDDEN", "Only administrators with status 9 can change user status")
	}
	if err != nil && err.Error() == "FORBIDDEN_BALANCE_CHANGE" {
		return adminUserError(ctx, "FORBIDDEN", "Only administrators with status 9 can change user balance")
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return adminUserError(ctx, "USER_NOT_FOUND", "User not found")
	}
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "duplicate") {
			return adminUserError(ctx, "DUPLICATE_LOGIN", "This login is already in use")
		}
		return adminUserError(ctx, "NOK", fmt.Sprintf("Cannot save user: %v", err))
	}
	ctx.Out["id"] = id
	return ctx.Out
}
