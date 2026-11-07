package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"main/models"
)

// These handlers use ARCHIVE_SECRET and ARCHIVE_TRUSTED_PROXY_IP from private config.go,
// and archiveRoot and isArchiveMounted from archive_record.go.
// The archive files have the structure:
// /mnt/sda/<channels.id>/<unix-minute>.ts
const (
	archivePlaybackTTL  = 6 * time.Hour
	archiveMaxProgramme = 24 * time.Hour
	archiveMinute       = int64(60)
)

type archivePlayRequest struct {
	ChannelID   uint32 `json:"channel_id"`
	ProgrammeID uint64 `json:"programme_id"`
}

type archivePlaybackClaims struct {
	ChannelID   uint32 `json:"c"`
	ProgrammeID uint64 `json:"p"`
	Start       int64  `json:"s"` // Unix seconds, actual EPG start
	Stop        int64  `json:"e"` // Unix seconds, actual EPG stop
	Expires     int64  `json:"x"` // Unix seconds
	IPHash      string `json:"i"` // HMAC fingerprint of client IP
}

type archivePlaybackSegment struct {
	Minute int64
	Path   string
}

// ARCHIVE_SECRET is derived from the private master key
// and the application version.
var ARCHIVE_SECRET = generateArchiveSecret()

func generateArchiveSecret() string {
	mac := hmac.New(
		sha256.New,
		[]byte(ARCHIVE_MASTER_SECRET),
	)

	_, _ = mac.Write([]byte("tvaplay:archive:" + VERSION))

	return hex.EncodeToString(mac.Sum(nil))
}

func archiveJSONError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status": code, "message": message,
	})
}

// archiveRequestIP uses X-Real-IP ONLY when the direct TCP peer is our
// explicitly configured Nginx proxy. Never trust user-supplied forwarding
// headers from an arbitrary direct connection.
// ARCHIVE_TRUSTED_PROXY_IP is declared in the private config.go.
func archiveRequestIP(r *http.Request) (net.IP, error) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return nil, errors.New("invalid remote address")
	}
	peer := net.ParseIP(host)
	if peer == nil {
		return nil, errors.New("invalid peer IP")
	}

	trusted := net.ParseIP(
		strings.TrimSpace(getSetting("archive_trusted_proxy_ip")),
	)
	if trusted != nil && peer.Equal(trusted) {
		forwarded := strings.TrimSpace(r.Header.Get("X-Real-IP"))
		// Reject lists and non-IP values. Nginx sets this to $remote_addr.
		ip := net.ParseIP(forwarded)
		if ip == nil {
			return nil, errors.New("trusted proxy did not supply a valid X-Real-IP")
		}
		return ip, nil
	}

	return peer, nil
}

// The address is not exposed directly in the signed playback URL.
func archiveIPFingerprint(ip net.IP) string {
	mac := hmac.New(sha256.New, []byte(ARCHIVE_SECRET))
	_, _ = mac.Write([]byte("tvaplay-archive-ip-v1:"))
	_, _ = mac.Write([]byte(ip.String()))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// signArchiveClaims produces an expiring, per-programme HMAC token.
// It is safe for clients which cannot send Authorization for HLS segments.
func signArchiveClaims(claims archivePlaybackClaims) (string, error) {
	secret := ARCHIVE_SECRET
	if len(secret) < 32 {
		return "", errors.New("ARCHIVE_SECRET must contain at least 32 bytes")
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	body := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(body))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return body + "." + signature, nil
}

func verifyArchiveClaims(token string) (archivePlaybackClaims, error) {
	var claims archivePlaybackClaims
	secret := ARCHIVE_SECRET
	if len(secret) < 32 || len(token) > 1024 {
		return claims, errors.New("token is not configured or too long")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return claims, errors.New("invalid token format")
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return claims, err
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(parts[0]))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return claims, errors.New("invalid token signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return claims, err
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return claims, err
	}
	now := time.Now().Unix()
	if claims.ChannelID == 0 || claims.ProgrammeID == 0 ||
		claims.Start <= 0 || claims.Stop <= claims.Start ||
		claims.Stop-claims.Start > int64(archiveMaxProgramme/time.Second) ||
		claims.Expires <= now ||
		claims.IPHash == "" ||
		claims.Expires > now+int64(archivePlaybackTTL/time.Second) {
		return archivePlaybackClaims{}, errors.New("expired or invalid token")
	}
	return claims, nil
}

// findArchivePlaybackSegments returns only finished, nonempty regular TS files.
// Absent minutes are retained as gaps in the HLS timeline.
func findArchivePlaybackSegments(c archivePlaybackClaims) ([]archivePlaybackSegment, error) {
	folder := filepath.Join(archiveRoot, strconv.FormatUint(uint64(c.ChannelID), 10))
	first := c.Start - c.Start%archiveMinute
	items := make([]archivePlaybackSegment, 0, int((c.Stop-c.Start)/archiveMinute)+2)
	for minute := first; minute < c.Stop; minute += archiveMinute {
		name := strconv.FormatInt(minute, 10) + ".ts"
		path := filepath.Join(folder, name)
		info, err := os.Lstat(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() || info.Size() == 0 {
			continue
		}
		items = append(items, archivePlaybackSegment{Minute: minute, Path: path})
	}
	return items, nil
}

func archiveStorageReady() bool {
	mounted, err := isArchiveMounted(archiveRoot)
	return err == nil && mounted
}

// POST /api/archive/play
// Authorization: Bearer <user-JWT>
// {"channel_id": 1, "programme_id": 1234}
func serveArchivePlay(w http.ResponseWriter, r *http.Request) {
	setDevCORS(w, r)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method == http.MethodOptions {
		if debug && w.Header().Get("Access-Control-Allow-Origin") != "" {
			w.WriteHeader(http.StatusNoContent)
		} else {
			http.Error(w, "Forbidden", http.StatusForbidden)
		}
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		archiveJSONError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Требуется POST")
		return
	}
	user, err := getAuthUser(r)
	if err != nil || user == nil {
		archiveJSONError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Требуется авторизация")
		return
	}
	if !archiveStorageReady() {
		archiveJSONError(w, http.StatusServiceUnavailable, "ARCHIVE_UNAVAILABLE", "Хранилище архива недоступно")
		return
	}

	var in archivePlayRequest
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil || in.ChannelID == 0 || in.ProgrammeID == 0 {
		archiveJSONError(w, http.StatusBadRequest, "INVALID_REQUEST", "Неверные channel_id или programme_id")
		return
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		archiveJSONError(w, http.StatusBadRequest, "INVALID_REQUEST", "Ожидался один JSON-объект")
		return
	}

	// Numeric channel ID matches archiveRoot/<id>, not the tvg-id/EPG ID.
	var channel models.Channel
	err = db.WithContext(r.Context()).
		Where("id = ? AND enable = ? AND record > ?", in.ChannelID, 1, 0).
		First(&channel).Error
	if err != nil {
		archiveJSONError(w, http.StatusNotFound, "CHANNEL_NOT_FOUND", "Канал с архивом не найден")
		return
	}
	if strings.TrimSpace(channel.EPGID) == "" {
		archiveJSONError(w, http.StatusNotFound, "EPG_NOT_FOUND", "Для канала не настроен EPG")
		return
	}

	var programme models.EPGProgramme
	err = db.WithContext(r.Context()).
		Where("id = ? AND channel_id = ?", in.ProgrammeID, strings.TrimSpace(channel.EPGID)).
		First(&programme).Error
	if err != nil {
		archiveJSONError(w, http.StatusNotFound, "PROGRAMME_NOT_FOUND", "Передача не найдена")
		return
	}

	now := time.Now()
	if !programme.Stop.After(programme.Start) || programme.Stop.After(now) {
		archiveJSONError(w, http.StatusConflict, "NOT_FINISHED", "Передача ещё не завершилась")
		return
	}
	if programme.Stop.Sub(programme.Start) > archiveMaxProgramme {
		archiveJSONError(w, http.StatusBadRequest, "PROGRAMME_TOO_LONG", "Слишком длинная передача")
		return
	}
	// Don't issue a misleading partial-playback link outside retention.
	cutoff := now.Add(-time.Duration(channel.Record) * time.Hour)
	if programme.Start.Before(cutoff) {
		archiveJSONError(w, http.StatusGone, "RECORD_EXPIRED", "Начало передачи вышло за срок хранения")
		return
	}

	clientIP, err := archiveRequestIP(r)
	if err != nil {
		slog("Archive playback: client IP: "+err.Error(), "error")
		archiveJSONError(w, http.StatusServiceUnavailable, "CLIENT_IP_UNAVAILABLE", "Не удалось определить IP клиента")
		return
	}

	claims := archivePlaybackClaims{
		ChannelID:   in.ChannelID,
		ProgrammeID: in.ProgrammeID,
		Start:       programme.Start.Unix(),
		Stop:        programme.Stop.Unix(),
		Expires:     now.Add(archivePlaybackTTL).Unix(),
		IPHash:      archiveIPFingerprint(clientIP),
	}
	segments, err := findArchivePlaybackSegments(claims)
	if err != nil {
		slog("Archive playback: scan: "+err.Error(), "error")
		archiveJSONError(w, http.StatusInternalServerError, "STORAGE_ERROR", "Не удалось прочитать архив")
		return
	}
	if len(segments) == 0 {
		archiveJSONError(w, http.StatusNotFound, "RECORD_NOT_FOUND", "TS-файлы передачи не найдены")
		return
	}
	token, err := signArchiveClaims(claims)
	if err != nil {
		slog("Archive playback: signing: "+err.Error(), "error")
		archiveJSONError(w, http.StatusServiceUnavailable, "NOT_CONFIGURED", "Не настроен ключ архивного воспроизведения")
		return
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":        "OK",
		"channel_id":    in.ChannelID,
		"programme_id":  in.ProgrammeID,
		"url":           "/archive/" + token + "/index.m3u8",
		"start":         programme.Start.UnixMilli(),
		"stop":          programme.Stop.UnixMilli(),
		"duration":      programme.Stop.Sub(programme.Start).Seconds(),
		"segment_count": len(segments),
		"expires":       claims.Expires * 1000,
	})
}

// GET|HEAD /archive/<signed-token>/index.m3u8
// GET|HEAD /archive/<signed-token>/segment/<unix-minute>.ts
func serveArchiveMedia(w http.ResponseWriter, r *http.Request) {
	setHLSCORS(w, r)
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method == http.MethodOptions {
		if debug && w.Header().Get("Access-Control-Allow-Origin") != "" {
			w.WriteHeader(http.StatusNoContent)
		} else {
			http.Error(w, "Forbidden", http.StatusForbidden)
		}
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/archive/"), "/")
	if len(parts) < 2 || len(parts) > 3 || parts[0] == "" {
		http.NotFound(w, r)
		return
	}
	claims, err := verifyArchiveClaims(parts[0])
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	clientIP, err := archiveRequestIP(r)
	if err != nil || !hmac.Equal([]byte(claims.IPHash), []byte(archiveIPFingerprint(clientIP))) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	if !archiveStorageReady() {
		http.Error(w, "Archive unavailable", http.StatusServiceUnavailable)
		return
	}
	if len(parts) == 2 && parts[1] == "index.m3u8" {
		serveArchivePlaylist(w, r, claims)
		return
	}
	if len(parts) == 3 && parts[1] == "segment" {
		serveArchiveSegment(w, r, claims, parts[2])
		return
	}
	http.NotFound(w, r)
}

func serveArchivePlaylist(w http.ResponseWriter, r *http.Request, c archivePlaybackClaims) {
	segments, err := findArchivePlaybackSegments(c)
	if err != nil {
		http.Error(w, "Archive storage error", http.StatusInternalServerError)
		return
	}
	if len(segments) == 0 {
		http.NotFound(w, r)
		return
	}
	var b strings.Builder
	b.Grow(128 + len(segments)*80)
	b.WriteString("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n")
	// First implementation: nominal segment duration. The recorder currently
	// doesn't persist real durations (~60.03 s in the inspected examples).
	b.WriteString("#EXT-X-TARGETDURATION:61\n#EXT-X-MEDIA-SEQUENCE:0\n")
	previous := int64(-1)
	for _, segment := range segments {
		if previous >= 0 && segment.Minute != previous+archiveMinute {
			b.WriteString("#EXT-X-DISCONTINUITY\n")
		}
		b.WriteString("#EXTINF:60.000,\n")
		fmt.Fprintf(&b, "segment/%d.ts\n", segment.Minute)
		previous = segment.Minute
	}
	b.WriteString("#EXT-X-ENDLIST\n")
	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Content-Disposition", `inline; filename="index.m3u8"`)
	w.Header().Set("Content-Length", strconv.Itoa(b.Len()))
	if r.Method != http.MethodHead {
		_, _ = io.WriteString(w, b.String())
	}
}

func serveArchiveSegment(w http.ResponseWriter, r *http.Request, c archivePlaybackClaims, name string) {
	if !strings.HasSuffix(name, ".ts") {
		http.NotFound(w, r)
		return
	}
	text := strings.TrimSuffix(name, ".ts")
	minute, err := strconv.ParseInt(text, 10, 64)
	if err != nil || minute <= 0 || minute%archiveMinute != 0 ||
		strconv.FormatInt(minute, 10) != text {
		http.NotFound(w, r)
		return
	}
	first := c.Start - c.Start%archiveMinute
	if minute < first || minute >= c.Stop {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	path := filepath.Join(archiveRoot,
		strconv.FormatUint(uint64(c.ChannelID), 10), name)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil || !stat.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "video/mp2t")
	// ServeContent implements Range, If-Modified-Since and HEAD without
	// loading the entire TS file into RAM.
	http.ServeContent(w, r, name, stat.ModTime(), f)
}
