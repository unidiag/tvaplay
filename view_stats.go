package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"

	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"gorm.io/gorm"

	"main/models"
)

// Statistics are based on successfully served, distinct media segments.
// This estimates delivery activity, not verified on-screen playback.
const (
	viewStatsMinDuration        = 180 * time.Second
	viewStatsMaxGap             = 30 * time.Second
	viewStatsIdleTimeout        = 60 * time.Second
	viewStatsArchiveMaxGap      = 90 * time.Second
	viewStatsArchiveIdleTimeout = 120 * time.Second
	viewStatsFlushPeriod        = 30 * time.Second
	viewStatsTick               = 10 * time.Second
	viewStatsMaxSessions        = 10000
	viewStatsCleanupPeriod      = 24 * time.Hour
)

type viewStatsKey struct {
	authSessionID uint64
	userID        uint32
	channelID     uint32
	programme     uint64
	kind          string
	ip            string
}

type viewStatsSession struct {
	id        string
	key       viewStatsKey
	started   time.Time
	lastSeen  time.Time
	duration  time.Duration
	lastMedia string
	saved     bool
	lastSaved time.Time
	ended     bool
}

type viewStatsManager struct {
	mu       sync.Mutex
	sessions map[viewStatsKey]*viewStatsSession
}

var viewStatistics = &viewStatsManager{sessions: make(map[viewStatsKey]*viewStatsSession)}

// LIVE EPG is resolved by the actual channel being streamed. A short cache
// prevents one SQL lookup per HLS segment for each viewer.
const viewStatsEPGCacheTTL = 30 * time.Second

type viewStatsEPGEntry struct {
	programmeID uint64
	expiresAt   time.Time
}

var viewStatsEPGCache = struct {
	sync.RWMutex
	items map[uint32]viewStatsEPGEntry
}{items: make(map[uint32]viewStatsEPGEntry)}

// viewStatsCurrentProgrammeID returns the current EPG programme for a LIVE
// channel. Missing EPG or a database error must never interrupt playback.
func viewStatsCurrentProgrammeID(channelID uint32) uint64 {
	if channelID == 0 || db == nil {
		return 0
	}
	now := time.Now()
	viewStatsEPGCache.RLock()
	cached, ok := viewStatsEPGCache.items[channelID]
	viewStatsEPGCache.RUnlock()
	if ok && now.Before(cached.expiresAt) {
		return cached.programmeID
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	var channel struct {
		EPGID string `gorm:"column:epgid"`
	}

	if err := db.WithContext(ctx).
		Table("channels").
		Select("epgid").
		Where("id = ?", channelID).
		Take(&channel).Error; err != nil {
		return 0
	}

	var programme struct {
		ID   uint64    `gorm:"column:id"`
		Stop time.Time `gorm:"column:stop"`
	}
	epgID := strings.TrimSpace(channel.EPGID)
	if epgID != "" {
		if err := db.WithContext(ctx).Table("epg_programmes").
			Select("id, stop").
			Where("channel_id = ? AND start <= ? AND stop > ?", epgID, now, now).
			Order("start DESC").Limit(1).Scan(&programme).Error; err != nil {
			return 0
		}
	}

	expiresAt := now.Add(viewStatsEPGCacheTTL)
	if programme.ID != 0 && programme.Stop.Before(expiresAt) {
		expiresAt = programme.Stop
	}
	viewStatsEPGCache.Lock()
	viewStatsEPGCache.items[channelID] = viewStatsEPGEntry{
		programmeID: programme.ID,
		expiresAt:   expiresAt,
	}
	viewStatsEPGCache.Unlock()
	return programme.ID
}

// viewStatsIdentity is called ONLY after getHLSAccess has granted access.
// parseToken validates the JWT signature and expiry; never trust an unsigned ID.
func viewStatsIdentity(token string) (uint32, uint64) {
	if token == "" {
		return 0, 0
	}
	claims, err := parseToken(token)
	if err != nil || claims.Type != tokenTypeHLS {
		return 0, 0
	}
	return uint32(claims.UserID), claims.AuthSessionID
}

func viewStatsNewID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		log.Printf("[VIEW-STATS] random session ID: %v", err)
		return ""
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[0:8], h[8:12], h[12:16], h[16:20], h[20:32])
}

// The tracker runs only for successful GET media deliveries, never playlists,
// HEAD, 304, redirects, errors, or duplicate/rewound media segments.
func viewStatsObserve(userID, channelID uint32, authSessionID uint64, programme uint64, kind, ip, media string) {
	if userID == 0 || channelID == 0 || media == "" || (kind != "live" && kind != "archive") {
		return
	}
	// Prevent an unbounded cardinality of client-IP strings.
	if len(ip) > 45 {
		return
	}
	key := viewStatsKey{authSessionID: authSessionID, userID: userID, channelID: channelID, programme: programme, kind: kind, ip: ip}
	now := time.Now()
	m := viewStatistics
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.sessions[key]
	if s != nil && now.Sub(s.lastSeen) > viewStatsIdleFor(s.key.kind) {
		// The background worker will flush and remove the old session.
		// Do not overwrite it before it can be finalized.
		return
	}
	if s == nil {
		if len(m.sessions) >= viewStatsMaxSessions {
			return
		}
		id := viewStatsNewID()
		if id == "" {
			return
		}
		m.sessions[key] = &viewStatsSession{
			id: id, key: key, started: now, lastSeen: now, lastMedia: media,
		}
		return
	}
	if media == s.lastMedia {
		return
	}
	// For LIVE, accept only forward-moving segment numbers. Repeated, cached
	// or rewound requests cannot increase recorded time.
	if kind == "live" {
		oldN, oldErr := strconv.ParseUint(strings.TrimSuffix(strings.TrimPrefix(s.lastMedia, "segment_"), ".ts"), 10, 64)
		newN, newErr := strconv.ParseUint(strings.TrimSuffix(strings.TrimPrefix(media, "segment_"), ".ts"), 10, 64)
		if oldErr != nil || newErr != nil || newN <= oldN {
			return
		}
	} else {
		oldN, oldErr := strconv.ParseInt(strings.TrimSuffix(s.lastMedia, ".ts"), 10, 64)
		newN, newErr := strconv.ParseInt(strings.TrimSuffix(media, ".ts"), 10, 64)
		if oldErr != nil || newErr != nil || newN <= oldN {
			return
		}
	}
	gap := now.Sub(s.lastSeen)
	maxGap := viewStatsMaxGap
	if kind == "archive" {
		maxGap = viewStatsArchiveMaxGap
	}
	if gap > 0 && gap <= maxGap {
		s.duration += gap
	}
	s.lastSeen = now
	s.lastMedia = media
}

func viewStatsIdleFor(kind string) time.Duration {
	if kind == "archive" {
		return viewStatsArchiveIdleTimeout
	}
	return viewStatsIdleTimeout
}

func viewStatsRow(s *viewStatsSession, ended bool) models.ViewStat {
	row := models.ViewStat{
		SessionID:   s.id,
		UserID:      s.key.userID,
		ChannelID:   s.key.channelID,
		ViewType:    s.key.kind,
		StartedAt:   s.started,
		LastSeenAt:  s.lastSeen,
		DurationSec: uint32(s.duration / time.Second),
	}
	if s.key.authSessionID != 0 {
		id := s.key.authSessionID
		row.AuthSessionID = &id
	}
	if s.key.programme != 0 {
		id := s.key.programme
		row.ProgrammeID = &id
	}
	if s.key.ip != "" {
		ip := s.key.ip
		row.IPAddress = &ip
	}
	if ended {
		end := s.lastSeen
		row.EndedAt = &end
	}
	return row
}

// All database writes happen in this single worker, never in request handlers.
// This avoids adding database latency to TS delivery.
func startViewStatsWorker() {
	go func() {
		flushTicker := time.NewTicker(viewStatsTick)
		cleanupTicker := time.NewTicker(viewStatsCleanupPeriod)

		defer flushTicker.Stop()
		defer cleanupTicker.Stop()

		// Очистка при запуске сервера
		viewStatsCleanup()

		for {
			select {
			case <-flushTicker.C:
				viewStatsFlush()

			case <-cleanupTicker.C:
				viewStatsCleanup()
			}
		}
	}()

	log.Printf(
		"[VIEW-STATS] enabled (min=%s, flush=%s, live idle=%s, archive idle=%s, cleanup=%s)",
		viewStatsMinDuration,
		viewStatsFlushPeriod,
		viewStatsIdleTimeout,
		viewStatsArchiveIdleTimeout,
		viewStatsCleanupPeriod,
	)
}

// viewStatsCleanup удаляет статистику просмотров старше
// трёх календарных месяцев.
//
// Используем ended_at, если просмотр завершён,
// иначе last_seen_at.
func viewStatsCleanup() {
	if db == nil {
		return
	}

	cutoff := time.Now().AddDate(0, -3, 0)

	result := db.
		Where(
			"(ended_at IS NOT NULL AND ended_at < ?) OR "+
				"(ended_at IS NULL AND last_seen_at < ?)",
			cutoff,
			cutoff,
		).
		Delete(&models.ViewStat{})

	if result.Error != nil {
		log.Printf(
			"[VIEW-STATS] cleanup error: %v",
			result.Error,
		)
		return
	}

	if result.RowsAffected > 0 {
		log.Printf(
			"[VIEW-STATS] cleanup: deleted %d records older than %s",
			result.RowsAffected,
			cutoff.Format("2006-01-02 15:04:05"),
		)
	}
}

func viewStatsFlush() {
	m := viewStatistics
	now := time.Now()
	// Hold the small manager lock for collecting snapshots only.
	type pending struct {
		key   viewStatsKey
		id    string
		row   models.ViewStat
		ended bool
	}
	var batch []pending
	m.mu.Lock()
	for key, s := range m.sessions {
		idle := now.Sub(s.lastSeen) >= viewStatsIdleFor(s.key.kind)
		if s.duration < viewStatsMinDuration {
			if idle {
				delete(m.sessions, key)
			}
			continue
		}
		if idle || !s.saved || now.Sub(s.lastSaved) >= viewStatsFlushPeriod {
			batch = append(batch, pending{key: key, id: s.id, row: viewStatsRow(s, idle), ended: idle})
		}
	}
	m.mu.Unlock()
	for _, item := range batch {
		// One session UUID => one row. ON CONFLICT never overwrites creation time.
		// Create on first flush, update the already existing row on subsequent flushes.
		var existing models.ViewStat
		err := db.Where("session_id = ?", item.id).First(&existing).Error
		if err != nil {
			// Use GORM's record-not-found sentinel (other errors should not be treated as a missing row).
			if !isViewStatsNotFound(err) {
				log.Printf("[VIEW-STATS] lookup: %v", err)
				continue
			}
			if err = db.Create(&item.row).Error; err != nil {
				log.Printf("[VIEW-STATS] create: %v", err)
				continue
			}
		} else {
			updates := map[string]interface{}{
				"last_seen_at": item.row.LastSeenAt,
				"duration_sec": item.row.DurationSec,
				"ended_at":     item.row.EndedAt,
			}
			if err = db.Model(&models.ViewStat{}).Where("session_id = ?", item.id).Updates(updates).Error; err != nil {
				log.Printf("[VIEW-STATS] update: %v", err)
				continue
			}
		}
		m.mu.Lock()
		if s := m.sessions[item.key]; s != nil && s.id == item.id {
			s.saved = true
			s.lastSaved = now
			if item.ended && !s.lastSeen.After(item.row.LastSeenAt) {
				delete(m.sessions, item.key)
			}
		}
		m.mu.Unlock()
	}
}

// A small status/byte counter that preserves flushing for HLS reverse proxy.
// Returning 200 with zero response bytes does not represent a delivered segment.
type viewStatsResponseWriter struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (w *viewStatsResponseWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}
func (w *viewStatsResponseWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(p)
	w.bytes += int64(n)
	return n, err
}
func (w *viewStatsResponseWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
func (w *viewStatsResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *viewStatsResponseWriter) delivered() bool {
	return (w.status == http.StatusOK || w.status == http.StatusPartialContent) && w.bytes > 0
}

func isViewStatsNotFound(err error) bool { return errors.Is(err, gorm.ErrRecordNotFound) }
