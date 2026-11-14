package main

import (
	"context"
	"errors"
	"fmt"
	"main/models"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"gorm.io/gorm"
)

func storageError(ctx *ApiCtx, status, message string) map[string]any {
	ctx.Out["status"] = status
	ctx.Out["message"] = message
	return ctx.Out
}

func parseStorageID(value string, allowZero bool) (uint, error) {
	value = strings.TrimSpace(value)
	if allowZero && (value == "" || value == "0") {
		return 0, nil
	}
	n, err := strconv.ParseUint(value, 10, 64)
	if err != nil || n == 0 || uint64(uint(n)) != n {
		return 0, errors.New("invalid storage ID")
	}
	return uint(n), nil
}

// Check all existing path components for symlinks, not just the final one.
func checkStoragePathSymlinks(path string) error {
	current := string(filepath.Separator)
	relative := strings.TrimPrefix(path, current)
	for _, part := range strings.Split(relative, string(filepath.Separator)) {
		if part == "" {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return errors.New("Storage path must not contain symlinks")
		}
		if !info.IsDir() {
			return errors.New("Storage path contains a non-directory component")
		}
	}
	return nil
}

// Creates a missing directory with mode 0777, preserving permissions of an
// existing directory. This does NOT verify that an expected disk is mounted.
func validateStoragePath(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 512 || strings.ContainsRune(value, 0) ||
		!filepath.IsAbs(value) {
		return "", errors.New("Storage path must be an absolute directory path")
	}
	cleaned := filepath.Clean(value)
	switch cleaned {
	case "/", "/mnt", "/media", "/var", "/home", "/tmp":
		return "", errors.New("Storage path is too broad")
	}
	if err := checkStoragePathSymlinks(cleaned); err != nil {
		return "", err
	}
	info, err := os.Lstat(cleaned)
	if err == nil {
		if !info.IsDir() {
			return "", errors.New("Storage path is not a directory")
		}
		return cleaned, nil
	}
	if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.MkdirAll(cleaned, 0777); err != nil {
		return "", errors.New("Cannot create storage directory: " + err.Error())
	}
	if err := os.Chmod(cleaned, 0777); err != nil {
		return "", errors.New("Cannot set storage directory permissions: " + err.Error())
	}
	if err := checkStoragePathSymlinks(cleaned); err != nil {
		return "", err
	}
	info, err = os.Lstat(cleaned)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("Storage path is not a directory")
	}
	return cleaned, nil
}

// Read total and used filesystem capacity; unlike a directory scan,
// Statfs includes all data stored on the volume.
func storageFilesystemSize(path string) (uint64, uint64, error) {
	var fs syscall.Statfs_t
	if err := syscall.Statfs(path, &fs); err != nil {
		return 0, 0, err
	}
	blockSize := uint64(fs.Bsize)
	total := fs.Blocks * blockSize
	used := (fs.Blocks - fs.Bfree) * blockSize
	return used, total, nil
}

type adminStorageRow struct {
	models.Storage
	SizeUsedBytes  *uint64 `json:"size_used_bytes"`
	SizeTotalBytes *uint64 `json:"size_total_bytes"`
	SizeError      string  `json:"size_error,omitempty"`
}

// POST {"op":"adminStorages"}
func apiAdminStorages(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}
	rows := make([]models.Storage, 0)
	if err := db.Order("id ASC").Find(&rows).Error; err != nil {
		return storageError(ctx, "NOK", "Cannot load storages")
	}
	result := make([]adminStorageRow, 0, len(rows))
	for _, storage := range rows {
		entry := adminStorageRow{Storage: storage}
		used, total, err := storageFilesystemSize(storage.Path)
		if err != nil {
			entry.SizeError = "Cannot read filesystem capacity"
		} else {
			entry.SizeUsedBytes = &used
			entry.SizeTotalBytes = &total
		}
		result = append(result, entry)
	}
	ctx.Out["storages"] = result
	return ctx.Out
}

// POST {"op":"adminStorageSave","id":0,"name":"Toshiba N300",
//
//	"path":"/mnt/sda","enabled":true}
func apiAdminStorageSave(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}

	id, err := parseStorageID(ctx.D["id"], true)
	if err != nil {
		return storageError(ctx, "INVALID_ID", "Invalid storage ID")
	}

	name := strings.TrimSpace(ctx.D["name"])
	if name == "" || len(name) > 255 {
		return storageError(ctx, "INVALID_NAME", "Storage name must be 1–255 bytes")
	}

	path, err := validateStoragePath(ctx.D["path"])
	if err != nil {
		return storageError(ctx, "INVALID_PATH", err.Error())
	}

	enabledText := ctx.D["enabled"]
	if enabledText != "0" && enabledText != "1" {
		return storageError(ctx, "INVALID_ENABLED", "Enabled must be true or false")
	}
	enabled := enabledText == "1"

	var saved models.Storage
	err = db.Transaction(func(tx *gorm.DB) error {
		var count int64
		q := tx.Model(&models.Storage{}).Where("path = ?", path)
		if id != 0 {
			q = q.Where("id <> ?", id)
		}
		if err := q.Count(&count).Error; err != nil {
			return err
		}
		if count != 0 {
			return errors.New("DUPLICATE_PATH")
		}

		if id == 0 {
			saved = models.Storage{Name: name, Path: path, Enabled: enabled}
			return tx.Create(&saved).Error
		}

		if err := tx.First(&saved, id).Error; err != nil {
			return err
		}
		if saved.Path != path {
			var channelCount int64
			if err := tx.Model(&models.Channel{}).Where("storage_id = ?", id).Count(&channelCount).Error; err != nil {
				return err
			}
			if channelCount > 0 {
				return errors.New("Storage path cannot change while assigned to channels")
			}
		}
		if err := tx.Model(&saved).Updates(map[string]any{
			"name": name, "path": path, "enabled": enabled,
		}).Error; err != nil {
			return err
		}
		return nil
	})

	if errors.Is(err, gorm.ErrRecordNotFound) {
		return storageError(ctx, "NOT_FOUND", "Storage not found")
	}
	if err != nil {
		if err.Error() == "DUPLICATE_PATH" ||
			strings.Contains(strings.ToLower(err.Error()), "duplicate") {
			return storageError(ctx, "DUPLICATE_PATH", "Storage path already exists")
		}
		return storageError(ctx, "NOK", "Cannot save storage")
	}

	ctx.Out["id"] = saved.ID
	return ctx.Out
}

// POST {"op":"adminStorageDelete","id":1}
// Deletes only the database row; never touches files or directories.
func apiAdminStorageDelete(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}

	id, err := parseStorageID(ctx.D["id"], false)
	if err != nil {
		return storageError(ctx, "INVALID_ID", "Invalid storage ID")
	}

	var channelCount int64
	if err := db.Model(&models.Channel{}).Where("storage_id = ?", id).Count(&channelCount).Error; err != nil {
		return storageError(ctx, "NOK", "Cannot check storage assignments")
	}
	if channelCount > 0 {
		return storageError(ctx, "IN_USE", "Storage is assigned to channels")
	}
	result := db.Delete(&models.Storage{}, id)
	if result.Error != nil {
		return storageError(ctx, "NOK", "Cannot delete storage")
	}
	if result.RowsAffected == 0 {
		return storageError(ctx, "NOT_FOUND", "Storage not found")
	}
	return ctx.Out
}

// ███████╗███╗   ███╗ █████╗ ██████╗ ████████╗
// ██╔════╝████╗ ████║██╔══██╗██╔══██╗╚══██╔══╝
// ███████╗██╔████╔██║███████║██████╔╝   ██║
// ╚════██║██║╚██╔╝██║██╔══██║██╔══██╗   ██║
// ███████║██║ ╚═╝ ██║██║  ██║██║  ██║   ██║
// ╚══════╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝

type storageSMARTAttribute struct {
	Name     string `json:"attribute_name"`
	RawValue string `json:"raw_value"`
}

// runStorageTool executes fixed diagnostic utilities without invoking a shell.
func runStorageTool(ctx context.Context, program string, args ...string) (string, error) {
	output, err := exec.CommandContext(ctx, program, args...).CombinedOutput()
	if err != nil {
		if ctx.Err() != nil {
			return "", errors.New("Storage diagnostic timed out")
		}
		return "", fmt.Errorf("%s failed: %s", program, strings.TrimSpace(string(output)))
	}
	return strings.TrimSpace(string(output)), nil
}

// storageSMARTDevice determines the local physical disk backing a directory.
// A directory on the root filesystem is valid for SMART *diagnostics*.
// This does not authorize archive writing to an unmounted storage path.
func storageSMARTDevice(ctx context.Context, path string) (string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", errors.New("Storage directory is unavailable")
	}

	source, err := runStorageTool(ctx, "findmnt", "--noheadings", "--output", "SOURCE", "--target", resolved)
	if err != nil {
		return "", err
	}
	// A bind mount can be displayed as /dev/sda1[/directory].
	if i := strings.IndexByte(source, '['); i >= 0 {
		source = source[:i]
	}
	source = strings.TrimSpace(source)
	if !strings.HasPrefix(source, "/dev/") || strings.ContainsAny(source, "\n\r\t ") {
		return "", errors.New("Storage is not backed by a direct local block device")
	}
	source, err = filepath.EvalSymlinks(source)
	if err != nil || !strings.HasPrefix(source, "/dev/") {
		return "", errors.New("Storage block device is unavailable")
	}

	kind, err := runStorageTool(ctx, "lsblk", "--nodeps", "--noheadings", "--output", "TYPE", source)
	if err != nil {
		return "", err
	}
	kind = strings.TrimSpace(kind)
	device := source
	if kind == "part" {
		parent, err := runStorageTool(ctx, "lsblk", "--nodeps", "--noheadings", "--output", "PKNAME", source)
		if err != nil {
			return "", err
		}
		parent = strings.TrimSpace(parent)
		if parent == "" || strings.ContainsAny(parent, "/ \n\r\t") || parent == "." || parent == ".." {
			return "", errors.New("Cannot resolve partition's parent disk")
		}
		device = filepath.Join("/dev", parent)
		kind, err = runStorageTool(ctx, "lsblk", "--nodeps", "--noheadings", "--output", "TYPE", device)
		if err != nil {
			return "", err
		}
		kind = strings.TrimSpace(kind)
	}
	if kind != "disk" {
		return "", errors.New("SMART requires a direct physical disk (RAID/LVM devices are not supported)")
	}
	return device, nil
}

// ATA/SATA smartctl -A output has ID, ATTRIBUTE_NAME, eight other columns,
// followed by RAW_VALUE. Preserve RAW_VALUE verbatim, including Min/Max.
func parseStorageATASMART(output string) []storageSMARTAttribute {
	rows := make([]storageSMARTAttribute, 0)
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 10 || len(fields[0]) > 3 {
			continue
		}
		if _, err := strconv.Atoi(fields[0]); err != nil {
			continue
		}
		rows = append(rows, storageSMARTAttribute{
			Name: fields[1], RawValue: strings.Join(fields[9:], " "),
		})
	}
	return rows
}

// NVMe uses "Name: value" lines instead of the ATA SMART attribute table.
// Only parse the SMART/Health Information section, not self-test or error logs.
func parseStorageNVMeSMART(output string) []storageSMARTAttribute {
	rows := make([]storageSMARTAttribute, 0)
	inHealth := false
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "SMART/Health Information") {
			inHealth = true
			continue
		}
		if !inHealth {
			continue
		}
		if line == "" {
			if len(rows) > 0 {
				break
			}
			continue
		}
		if strings.HasPrefix(line, "Error Information") || strings.HasPrefix(line, "Self-test") || strings.HasPrefix(line, "===") {
			break
		}
		separator := strings.IndexByte(line, ':')
		if separator <= 0 {
			continue
		}
		name := strings.TrimSpace(line[:separator])
		value := strings.TrimSpace(line[separator+1:])
		if name == "" || value == "" {
			continue
		}
		rows = append(rows, storageSMARTAttribute{Name: name, RawValue: value})
	}
	return rows
}

func parseStorageSMART(output string) []storageSMARTAttribute {
	if strings.Contains(output, "SMART/Health Information (NVMe") {
		return parseStorageNVMeSMART(output)
	}
	return parseStorageATASMART(output)
}

// POST {"op":"adminStorageSmart","id":1}
func apiAdminStorageSmart(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}
	id, err := parseStorageID(ctx.D["id"], false)
	if err != nil {
		return storageError(ctx, "INVALID_ID", "Invalid storage ID")
	}

	var storage models.Storage
	if err := db.First(&storage, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return storageError(ctx, "NOT_FOUND", "Storage not found")
		}
		return storageError(ctx, "NOK", "Cannot load storage")
	}

	timeoutCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	device, err := storageSMARTDevice(timeoutCtx, storage.Path)
	if err != nil {
		return storageError(ctx, "DEVICE_ERROR", err.Error())
	}
	if _, err := os.Stat(device); err != nil {
		return storageError(ctx, "DEVICE_ERROR", "Physical disk is unavailable")
	}

	// smartctl returns bitmask exit codes. Some bits indicate SMART health
	// warnings even when -A successfully prints an attribute table, so retain
	// and parse its output rather than rejecting every nonzero exit status.
	outputBytes, runErr := exec.CommandContext(timeoutCtx, "smartctl", "-A", device).CombinedOutput()
	if timeoutCtx.Err() != nil {
		return storageError(ctx, "SMART_ERROR", "SMART diagnostic timed out")
	}
	output := string(outputBytes)
	attributes := parseStorageSMART(output)
	if len(attributes) == 0 {
		if runErr != nil {
			return storageError(ctx, "SMART_ERROR", "Cannot read SMART attributes from device")
		}
		return storageError(ctx, "UNSUPPORTED", "No supported SATA or NVMe SMART attributes found")
	}
	ctx.Out["device"] = device
	ctx.Out["attributes"] = attributes
	return ctx.Out
}

//  ██████╗ ██████╗  █████╗ ██████╗ ██╗  ██╗
// ██╔════╝ ██╔══██╗██╔══██╗██╔══██╗██║  ██║
// ██║  ███╗██████╔╝███████║██████╔╝███████║
// ██║   ██║██╔══██╗██╔══██║██╔═══╝ ██╔══██║
// ╚██████╔╝██║  ██║██║  ██║██║     ██║  ██║
//  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝

// POST {"op":"adminStorageMetrics","id":1,"hours":24}
// hours: 24 or 168. Returns minute aggregates for exactly one storage.
func apiAdminStorageMetrics(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}

	id, err := parseStorageID(ctx.D["id"], false)
	if err != nil {
		return storageError(ctx, "INVALID_ID", "Invalid storage ID")
	}

	hours := 24
	if value := strings.TrimSpace(ctx.D["hours"]); value != "" {
		hours, err = strconv.Atoi(value)
		if err != nil || (hours != 24 && hours != 168) {
			return storageError(ctx, "INVALID_PERIOD", "Period must be 24 or 168 hours")
		}
	}

	var storage models.Storage
	if err := db.Select("id", "name", "path").First(&storage, id).Error; err != nil {
		return storageError(ctx, "NOT_FOUND", "Storage not found")
	}

	now := time.Now().UTC()
	cutoff := now.Add(-time.Duration(hours) * time.Hour)

	rows := make([]models.StorageMetric, 0)
	if err := db.Where("storage_id = ? AND minute >= ? AND minute <= ?", id, cutoff, now).
		Order("minute ASC").Limit(hours*60 + 1).Find(&rows).Error; err != nil {
		return storageError(ctx, "NOK", "Cannot load storage history")
	}

	ctx.Out["storage_id"] = storage.ID
	ctx.Out["device"] = ""
	if len(rows) > 0 {
		ctx.Out["device"] = rows[len(rows)-1].Device
	}
	ctx.Out["hours"] = hours
	ctx.Out["metrics"] = rows
	return ctx.Out
}
