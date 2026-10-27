package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const archiveCleanupInterval = 1 * time.Minute

// archiveWorker запускает очистку сразу,
// затем повторяет её с заданным интервалом.
func archiveWorker() {
	ticker := time.NewTicker(archiveCleanupInterval)
	defer ticker.Stop()

	for {
		started := time.Now()

		deleted, freed, err := cleanupArchive()

		if err != nil {
			slog("Archive cleanup error: "+err.Error(), "error")
		} else if debug {
			slog(fmt.Sprintf(
				"Archive cleanup: deleted=%d, freed=%.2f GB, duration=%s",
				deleted,
				float64(freed)/1024/1024/1024,
				time.Since(started).Round(time.Millisecond),
			))
		}

		<-ticker.C
	}
}

// Проверяет, что ARCH_PATH является точкой монтирования.
// Для Linux используется /proc/self/mountinfo.
func isArchiveMounted(path string) (bool, error) {
	data, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return false, err
	}

	target, err := filepath.Abs(path)
	if err != nil {
		return false, err
	}

	target = filepath.Clean(target)

	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)

		if len(fields) < 5 {
			continue
		}

		// Пятое поле mountinfo — mount point.
		mountPoint := strings.ReplaceAll(
			fields[4], `\040`, " ",
		)

		if filepath.Clean(mountPoint) == target {
			return true, nil
		}
	}

	return false, nil
}

// cleanupArchive удаляет старые TS-файлы.
// Возвращает количество удалённых файлов
// и объём освобождённого пространства в байтах.
func cleanupArchive() (int, int64, error) {
	if ARCH_HOURS <= 0 {
		return 0, 0, fmt.Errorf(
			"invalid ARCH_HOURS: %d", ARCH_HOURS,
		)
	}

	if ARCH_PATH == "" || filepath.Clean(ARCH_PATH) == "/" {
		return 0, 0, fmt.Errorf(
			"invalid ARCH_PATH: %q", ARCH_PATH,
		)
	}

	mounted, err := isArchiveMounted(ARCH_PATH)
	if err != nil {
		return 0, 0, fmt.Errorf(
			"mount check: %w", err,
		)
	}

	if !mounted {
		return 0, 0, fmt.Errorf(
			"archive is not mounted: %s", ARCH_PATH,
		)
	}

	cutoff := time.Now().Add(
		-time.Duration(ARCH_HOURS) * time.Hour,
	).Unix()

	channels, err := os.ReadDir(ARCH_PATH)
	if err != nil {
		return 0, 0, fmt.Errorf(
			"read archive directory: %w", err,
		)
	}

	var deleted int
	var freed int64
	var failed int

	for _, channel := range channels {
		// Обрабатываем только реальные директории.
		// Символические ссылки пропускаем.
		if !channel.IsDir() {
			continue
		}

		channelPath := filepath.Join(
			ARCH_PATH,
			channel.Name(),
		)

		files, err := os.ReadDir(channelPath)
		if err != nil {
			failed++
			slog(fmt.Sprintf(
				"Archive: read %s: %v",
				channelPath, err,
			), "error")
			continue
		}

		for _, file := range files {
			// Не трогаем вложенные каталоги,
			// символические ссылки и другие типы файлов.
			if !file.Type().IsRegular() {
				continue
			}

			name := file.Name()

			if filepath.Ext(name) != ".ts" {
				continue
			}

			// Имя файла должно быть Unix timestamp
			// в секундах, например 1792501200.ts.
			timestampStr := strings.TrimSuffix(
				name, ".ts",
			)

			timestamp, err := strconv.ParseInt(
				timestampStr, 10, 64,
			)
			if err != nil || timestamp <= 0 {
				continue
			}

			if timestamp >= cutoff {
				continue
			}

			filePath := filepath.Join(
				channelPath,
				name,
			)

			info, err := os.Lstat(filePath)
			if err != nil {
				failed++
				continue
			}

			// Повторная проверка перед удалением.
			if !info.Mode().IsRegular() {
				continue
			}

			if err := os.Remove(filePath); err != nil {
				failed++
				slog(fmt.Sprintf(
					"Archive: remove %s: %v",
					filePath, err,
				), "error")
				continue
			}

			deleted++
			freed += info.Size()
		}
	}

	if failed > 0 {
		return deleted, freed, fmt.Errorf(
			"cleanup completed with %d errors; deleted=%d, freed=%d bytes",
			failed, deleted, freed,
		)
	}

	return deleted, freed, nil
}
