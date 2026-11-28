package main

import (
	"context"
	"errors"
	"log"
	"net/netip"
	"strings"
	"time"

	"main/models"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	homeIPIdleTimeout       = 90 * time.Second
	homeIPHeartbeatInterval = 15 * time.Second
)

var errInvalidHomeIP = errors.New("invalid client IP")

func normalizeHomeIP(value string) (string, error) {
	ip, err := netip.ParseAddr(strings.TrimSpace(value))
	if err != nil {
		return "", errInvalidHomeIP
	}
	ip = ip.Unmap()
	if !ip.IsValid() || ip.IsUnspecified() {
		return "", errInvalidHomeIP
	}
	return ip.String(), nil
}

// allowHomeIP permits only one current client IP per subscriber.
// It never revokes existing refresh sessions or JWTs.
func allowHomeIP(ctx context.Context, userID uint, clientIP string) (bool, error) {
	if userID == 0 {
		return false, errors.New("invalid user ID")
	}
	ip, err := normalizeHomeIP(clientIP)
	if err != nil {
		return false, err
	}

	now := time.Now().UTC()
	allowed := false
	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var user models.User
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Select("id", "home_ip", "home_ip_seen_at", "home_ip_changed_at").
			First(&user, userID).Error; err != nil {
			return err
		}

		if user.HomeIP == "" {
			if err := tx.Model(&user).UpdateColumns(map[string]any{
				"home_ip":            ip,
				"home_ip_seen_at":    now,
				"home_ip_changed_at": now,
			}).Error; err != nil {
				return err
			}
			log.Printf("[HOME IP] user=%d initial ip=%s", userID, ip)
			allowed = true
			return nil
		}

		if user.HomeIP == ip {
			allowed = true
			if user.HomeIPSeenAt != nil && now.Sub(*user.HomeIPSeenAt) < homeIPHeartbeatInterval {
				return nil
			}
			return tx.Model(&user).UpdateColumn("home_ip_seen_at", now).Error
		}

		if user.HomeIPSeenAt != nil && now.Sub(*user.HomeIPSeenAt) < homeIPIdleTimeout {
			return nil
		}

		oldIP := user.HomeIP
		if err := tx.Model(&user).UpdateColumns(map[string]any{
			"home_ip":            ip,
			"home_ip_seen_at":    now,
			"home_ip_changed_at": now,
		}).Error; err != nil {
			return err
		}
		log.Printf("[HOME IP] user=%d changed %s -> %s", userID, oldIP, ip)
		allowed = true
		return nil
	})
	if err != nil {
		return false, err
	}
	return allowed, nil
}
