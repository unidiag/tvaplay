package main

import "time"

func apiGetTime(ctx *ApiCtx) map[string]any {
	out := ctx.Out
	out["time"] = time.Now().Format("2006-01-02 15:04:05")
	return out
}
