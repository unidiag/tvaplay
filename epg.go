package main

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"main/models"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	epgInterval    = time.Hour
	epgBatchSize   = 500
	epgMaxSize     = 256 << 20
	epgArchiveDays = 3
)

var EPGCategories = map[string]string{
	"general":       "Общие",
	"regional":      "Региональные",
	"news":          "Новости",
	"sports":        "Спорт",
	"movies":        "Кино",
	"series":        "Сериалы",
	"kids":          "Детские",
	"music":         "Музыка",
	"documentary":   "Познавательные",
	"entertainment": "Развлекательные",
	"thematic":      "Тематические",
	"xxx":           "XXX (18+)",
}

type epgText struct {
	Value string `xml:",chardata"`
}

type epgIcon struct {
	Src string `xml:"src,attr"`
}

type epgChannelXML struct {
	ID       string  `xml:"id,attr"`
	Name     epgText `xml:"display-name"`
	Icon     epgIcon `xml:"icon"`
	Category string  `xml:"category,attr"`
}

type epgProgrammeXML struct {
	ID          string    `xml:"id,attr"`
	Channel     string    `xml:"channel,attr"`
	Start       string    `xml:"start,attr"`
	Stop        string    `xml:"stop,attr"`
	DataURL     string    `xml:"data,attr"`
	Title       epgText   `xml:"title"`
	Description epgText   `xml:"desc"`
	Categories  []epgText `xml:"category"`
	Country     epgText   `xml:"country"`
	Icon        epgIcon   `xml:"icon"`
	Date        string    `xml:"date"`
	Rating      epgText   `xml:"rating>value"`
}

// Запускает обновление сразу, затем каждый час.
func epgWorker() {
	ticker := time.NewTicker(epgInterval)
	defer ticker.Stop()

	for {
		started := time.Now()

		ctx, cancel := context.WithTimeout(
			context.Background(),
			20*time.Minute,
		)

		if err := updateEPG(ctx); err != nil {
			slog("EPG update error: "+err.Error(), "error")
		} else {
			slog(fmt.Sprintf(
				"EPG updated in %s",
				time.Since(started).Round(time.Millisecond),
			))
		}

		cancel()
		<-ticker.C
	}
}

// Скачивает XMLTV во временный файл.
func downloadEPG(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(
		ctx, http.MethodGet, EPGLINK, nil,
	)
	if err != nil {
		return "", err
	}

	req.Header.Set("User-Agent", APPNAME+"/"+VERSION)
	req.Header.Set("Accept", "application/xml, text/xml")

	client := &http.Client{
		Timeout: 5 * time.Minute,
	}

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("EPG HTTP %d", resp.StatusCode)
	}

	file, err := os.CreateTemp("", "tvaplay-epg-*.xml")
	if err != nil {
		return "", err
	}

	path := file.Name()

	size, copyErr := io.Copy(
		file,
		io.LimitReader(resp.Body, epgMaxSize+1),
	)
	closeErr := file.Close()

	if copyErr != nil || closeErr != nil || size > epgMaxSize {
		os.Remove(path)

		if copyErr != nil {
			return "", copyErr
		}
		if closeErr != nil {
			return "", closeErr
		}
		return "", fmt.Errorf("EPG XML too large")
	}

	return path, nil
}

// Потоковый разбор XMLTV без загрузки всего XML в память.
func parseEPG(
	ctx context.Context,
	path string,
	onChannel func(epgChannelXML) error,
	onProgramme func(epgProgrammeXML) error,
) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	decoder := xml.NewDecoder(file)

	var rootSeen bool
	var rootClosed bool
	var channels int
	var programmes int

	for {
		if err := ctx.Err(); err != nil {
			return err
		}

		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}

		switch el := token.(type) {
		case xml.StartElement:
			if !rootSeen {
				if el.Name.Local != "tv" {
					return fmt.Errorf("invalid XMLTV root")
				}
				rootSeen = true
				continue
			}

			switch el.Name.Local {
			case "channel":
				var c epgChannelXML

				if err := decoder.DecodeElement(&c, &el); err != nil {
					return err
				}
				if strings.TrimSpace(c.ID) == "" {
					return fmt.Errorf("empty channel id")
				}
				channels++

				if onChannel != nil {
					if err := onChannel(c); err != nil {
						return err
					}
				}

			case "programme":
				var p epgProgrammeXML

				if err := decoder.DecodeElement(&p, &el); err != nil {
					return err
				}
				if p.Channel == "" {
					return fmt.Errorf("empty programme channel")
				}

				start, err := parseEPGTime(p.Start)
				if err != nil {
					return err
				}
				stop, err := parseEPGTime(p.Stop)
				if err != nil {
					return err
				}
				if !stop.After(start) {
					return fmt.Errorf("invalid programme interval")
				}

				programmes++

				if onProgramme != nil {
					if err := onProgramme(p); err != nil {
						return err
					}
				}
			}

		case xml.EndElement:
			if el.Name.Local == "tv" {
				rootClosed = true
			}
		}
	}

	if !rootSeen || !rootClosed ||
		channels == 0 || programmes == 0 {
		return fmt.Errorf(
			"incomplete XMLTV: channels=%d programmes=%d",
			channels, programmes,
		)
	}

	return nil
}

func parseEPGTime(value string) (time.Time, error) {
	const layout = "20060102150405 -0700"

	t, err := time.Parse(layout, strings.TrimSpace(value))
	if err != nil {
		return time.Time{}, fmt.Errorf(
			"invalid XMLTV time %q: %w", value, err,
		)
	}

	return t.In(time.Local), nil
}

func updateEPG(ctx context.Context) error {
	path, err := downloadEPG(ctx)
	if err != nil {
		return err
	}
	defer os.Remove(path)

	// Проверяем весь XML перед изменением БД.
	if err := parseEPG(ctx, path, nil, nil); err != nil {
		return fmt.Errorf("EPG validation: %w", err)
	}

	// Уникальный идентификатор текущей загрузки.
	syncID := time.Now().UnixNano()

	var channelCount int
	var programmeCount int

	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		batch := make([]models.EPGProgramme, 0, epgBatchSize)

		flush := func() error {
			if len(batch) == 0 {
				return nil
			}

			err := tx.Clauses(clause.OnConflict{
				Columns: []clause.Column{
					{Name: "channel_id"},
					{Name: "start"},
				},
				DoUpdates: clause.AssignmentColumns([]string{
					"epg_id",
					"stop",
					"title",
					"description",
					"categories",
					"country",
					"icon",
					"rating",
					"date",
					"data_url",
					"synced_at",
					"updated_at",
				}),
			}).CreateInBatches(&batch, epgBatchSize).Error

			batch = batch[:0]
			return err
		}

		err := parseEPG(ctx, path,
			func(c epgChannelXML) error {

				category := strings.TrimSpace(c.Category)

				if _, ok := EPGCategories[category]; !ok {
					category = "general"
				}

				channel := models.EPGChannel{
					ID:       c.ID,
					Name:     strings.TrimSpace(c.Name.Value),
					Icon:     c.Icon.Src,
					Category: category,
				}

				if err := tx.Clauses(clause.OnConflict{
					Columns: []clause.Column{
						{Name: "id"},
					},
					DoUpdates: clause.AssignmentColumns([]string{
						"name", "icon", "category", "updated_at",
					}),
				}).Create(&channel).Error; err != nil {
					return err
				}

				channelCount++
				return nil
			},
			func(p epgProgrammeXML) error {
				start, _ := parseEPGTime(p.Start)
				stop, _ := parseEPGTime(p.Stop)

				categories := make([]string, 0, len(p.Categories))
				for _, c := range p.Categories {
					categories = append(
						categories, strings.TrimSpace(c.Value),
					)
				}

				categoryJSON, err := json.Marshal(categories)
				if err != nil {
					return err
				}

				batch = append(batch, models.EPGProgramme{
					EPGID:       p.ID,
					ChannelID:   p.Channel,
					Start:       start,
					Stop:        stop,
					Title:       strings.TrimSpace(p.Title.Value),
					Description: strings.TrimSpace(p.Description.Value),
					Categories:  string(categoryJSON),
					Country:     strings.TrimSpace(p.Country.Value),
					Icon:        p.Icon.Src,
					Rating:      strings.TrimSpace(p.Rating.Value),
					Date:        p.Date,
					DataURL:     p.DataURL,
					SyncedAt:    syncID,
				})

				programmeCount++

				if len(batch) >= epgBatchSize {
					return flush()
				}
				return nil
			},
		)

		if err != nil {
			return err
		}

		if err := flush(); err != nil {
			return err
		}

		now := time.Now()
		archiveThreshold := now.Add(-epgArchiveDays * 24 * time.Hour)

		// Удаляем передачи, закончившиеся более 5 суток назад.
		if err := tx.Where(
			"stop < ?", archiveThreshold,
		).Delete(&models.EPGProgramme{}).Error; err != nil {
			return err
		}

		// Удаляем только отсутствующие в новой XMLTV передачи,
		// которые ещё не завершились.
		// Архив уже завершившихся передач сохраняем.
		if err := tx.Where(
			"synced_at <> ? AND stop > ?", syncID, now,
		).Delete(&models.EPGProgramme{}).Error; err != nil {
			return err
		}

		return nil
	})

	if err != nil {
		return fmt.Errorf("EPG database update: %w", err)
	}

	slog(fmt.Sprintf(
		"EPG imported: %d channels, %d programmes",
		channelCount, programmeCount,
	))

	return nil
}
