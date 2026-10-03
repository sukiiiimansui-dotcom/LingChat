// 繁體中文（香港）语言包 · **由 OpenCC(cn→hk) 从 zh-CN/worldsim.ts 生成**
// 口径与 `scripts/generate-zh-hk.mjs` 完全一致（只转字符串值、键名不动）；
// ⚠️ 那份脚本会整仓重跑（连带覆盖手写模块），所以本文件是**单独**按同一口径补的：
//    以后改 zh-CN/worldsim.ts 后，可重跑 `node ~/chk/gen-zh-hk-worldsim.mjs` 同步这一个文件。
export default {
  "phone": {
    "open": "📱 懸浮手機",
    "title": "📱 懸浮手機",
    "close": "收起手機",
    "footHint": "點應用即可打開；標了編號的還沒接，在路線圖上"
  },
  "entry": "世界模擬",
  "title": "世界模擬",
  "enter": "進入",
  "generate": "生成小區地圖",
  "reselect": "換個區縣",
  "reLocate": "重新定位",
  "manual": "手動選城市",
  "ipEstimate": "用 IP 估測",
  "restart": "重新引導",
  "back": "返回",
  "retry": "重試",
  "refresh": "刷新",
  "loading": "讀取中…",
  "loader": {
    "busy": "讀取中…",
    "elapsed": "已等 {n} 秒",
    "eta": "約還需 {n} 秒（估算）",
    "etaUnknown": "剩餘時間還估不準",
    "rate": "{n} 項/秒",
    "cancel": "停止",
    "init": {
      "text": "正在展開世界…",
      "sub": "準備全國省級輪廓（只畫省界）…",
      "longHint": "首次進入要把全國輪廓準備好，之後就快了"
    },
    "locate": {
      "text": "正在定位",
      "longHint": "位置服務響應慢；真等不到會給你手動選城市的入口"
    },
    "locateFailed": {
      "text": "沒能自動定位"
    },
    "map": {
      "text": "正在加載地圖",
      "sub": "後端渲染中…",
      "longHint": "這一張比平時慢，畫好會自動換上來"
    },
    "pickColumn": "加載列表…",
    "pickList": "正在取行政區劃列表…",
    "pickHead": "加載中",
    "searching": "搜索中…",
    "sketch": {
      "text": "正在畫小區草圖…",
      "sub": "本地規則生成，通常不到 1 秒"
    },
    "draw": {
      "title": "AI 精繪中",
      "done": "AI 精繪完成 ✨",
      "undone": "AI 精繪未完成",
      "stage": {
        "think": "構思佈局",
        "buildings": "落建築",
        "roads": "鋪路綠化",
        "finish": "收尾"
      },
      "stageText": {
        "think": "正在構思佈局…",
        "buildings": "正在落建築…",
        "roads": "正在鋪路與綠化…",
        "finish": "正在收尾…"
      },
      "dropped": "已達繪製上限，另有 {n} 項未畫出",
      "name": "小區名：{name}",
      "retry": "重畫",
      "retryFull": "重試 AI 精繪",
      "longHint": "畫的過程中可以拖動地圖查看；離開這一步會中斷繪製",
      "badgeAi": "AI 精繪",
      "badgeSketch": "本地草圖"
    }
  },
  "stage": {
    "boot": "初始化",
    "locating": "定位中",
    "locateFailed": "待選位置",
    "manual": "手動選擇",
    "confirm": "確認位置",
    "neighborhood": "小區"
  },
  "actor": {
    "me": "我"
  },
  "soon": "即將上線",
  "emotionNormal": "正常",
  "pos": {
    "runtime": "世界運行中（後端實時）",
    "schedule": "按日程推算",
    "scatter": "本地散開（暫無位置數據）",
    "me": "你的位置",
    "affinity": "特地來找你（好感驅動）"
  },
  "panel": {
    "title": "角色",
    "close": "收起面板",
    "onStage": "在場",
    "portrait": "立繪",
    "portraitExpand": "點開查看立繪",
    "portraitCollapse": "收起立繪",
    "portraitLoading": "正在加載立繪…",
    "portraitNone": "這個角色還沒有立繪素材",
    "portraitFailed": "立繪加載失敗（文件可能在角色目錄裏被改過名）",
    "clothes": "服裝",
    "clothesDefault": "默認",
    "clothesMissing": "這套服裝沒有立繪，已切回默認",
    "schedule": "日程",
    "scheduleNow": "現在",
    "scheduleNext": "接下來",
    "location": "位置",
    "area": "行政區",
    "place": "地點",
    "posSource": "位置來源",
    "goto": "去找他聊聊",
    "gotoNow": "你們正在聊着，點了直接回對話",
    "gotoWarn": "注意：這個角色不是當前對話對象，聊天裏還要再選一次 ta",
    "actions": "快捷動作",
    /* ❤️⚡ 期 2（2026-10-02）：心情 / 體力（0–1 的**推導值**，口徑寫在 `wsNeeds.ts`） */
    "needsMood": "心情",
    "needsEnergy": "體力",
    "needsNone": "數不出來（沒有可用的世界狀態）"
  },
  "action": {
    "hi": "打招呼",
    "gift": "送禮物",
    "outing": "約他出門",
    "hint": "打招呼 = 跳到聊天（不動你現有的對話記錄）；約他出門 = 他動身來找你；送禮物還沒定方案，點開會説明白。",
    "outingHere": "你身邊",
    "outingNoMe": "還沒拿到你自己的位置，先在「我的面板」裏確認位置再來約他。",
    "outingStarted": "已約上：{name} 正在過來",
    "outingFailed": "沒約上{reason}"
  },
  "cmd": {
    "title": "指揮他",
    "to": "去哪兒",
    "toPlaceholder": "設施名或地名（回車 / 點右邊按鈕）",
    "go": "讓他去",
    "viaChat": "在聊天裏説",
    "hint": "這條指令與聊天裏説「你去便利店」是同一條下游：後端起一條行程，地圖上會走路過去、到達後位置自動回填。"
  },
  "intervene": {
    "on": "允許我干預他的行動",
    "off": "不干預（默認）",
    "hint": "默認關：他按自己的日程走。打開後可以把地圖上的頭像拖到別處指揮他。",
    "dragHint": "已打開：按住地圖上的頭像拖到別處，他就會走過去（鬆手前會先報距離與預計時間）。",
    "offToast": "干預沒打開：去角色面板 →「指揮他」裏打開「允許我干預他的行動」，才能把他拖走。",
    "noMap": "現在量不到地圖尺寸，先鬆手再拖一次（不猜位置，免得把他挪到錯的地方）。",
    "unsupported": "這個世界沒接上行程後端（瀏覽器預覽裏沒有），指揮暫時發不出去。",
    "moveHere": "移動到這裏",
    "estimate": "{name} → {place}：約 {dist}，步行 {min} 分鐘",
    "started": "已出發：{name} → {place}",
    "failed": "沒能起程{reason}",
    "m": "{n} 米",
    "km": "{n} 公里"
  },
  "gift": {
    "title": "送禮物（方案還沒定）",
    "lead": "這個功能還沒定方案，所以按鈕先不做任何事 —— 不自己發明一套禮物系統。下面兩個候選，選哪個由你拍板：",
    "optA": "方案 A · 走「關係」：禮物從記憶裏推斷",
    "optADesc": "不新增物品欄：從角色的記憶/關係裏挑一件「他會喜歡的東西」，送完寫一條記憶 + 關係值 +N。（需要後端加一個關係值接口）",
    "optB": "方案 B · 走「物品欄」：禮物由玩家自己維護",
    "optBDesc": "玩家先維護一份禮物清單（存本機或後端），送的時候從清單裏挑一件；送完扣一件 + 寫記憶 + 觸發一條事件。（需要一份持久化清單與背包接口）",
    "footer": "在你選定之前，點這個按鈕只會彈出這段説明，不會產生任何副作用。",
    "close": "知道了"
  },
  "perf": {
    "title": "性能",
    "auto": "自動",
    "high": "高畫質",
    "low": "省電",
    "autoHint": "按核數 / 設備內存 / 實測幀率自動判定（只降不升）",
    "highHint": "強制高畫質：動畫與毛玻璃全開",
    "lowHint": "強制省電：關裝飾性動畫與毛玻璃、少畫氣泡、頭像縮放降頻",
    "fps": "FPS",
    "fpsHint": "顯示實時幀率（默認關，只在手動開啓時出現）",
    "now": "當前：{tier}（{why}）",
    "tierHigh": "高畫質",
    "tierLow": "省電",
    "whyAuto": "自動判定",
    "whyManual": "你手動指定",
    "envNone": "沒有可用的設備信號",
    "envCores": "{n} 核",
    "envMem": "{n}GB 內存",
    "envFps": "實測 {n} fps"
  },
  "chat": {
    "noRole": "這個角色沒有角色庫 ID，暫時去不了對話（ta 可能只在日程裏出現過）",
    "switchWarn": "「{name}」不是當前對話角色。\n繼續會跳到聊天頁，你需要在那邊再選一次 ta。\n（這一步**不會**動你現在的對話記錄）\n\n現在就過去嗎？"
  },
  /* ══ 2026-10-03 · 期 3「走近説話」（`PLAN-GAMEPLAY.md:69-76`）· 對話抽屜 + 走近入口 ══
     ⚠️ `prefix` / `noPrefix` 要説清「到底會帶上什麼」：那一截世界狀態是拼在正文前面的真實文本，
        界面把它原樣給玩家看；拿不到時如實説「只發你這句話」（口徑與 zh-CN 同）。 */
  "chatDrawer": {
    "title": "走近説話",
    "close": "收起",
    "noWho": "（還沒選中誰）",
    "empty": "還沒説過話 —— 就在這兒説第一句",
    "placeholder": "説點什麼…（回車發送，Shift+回車換行）",
    "send": "説",
    "sending": "正在發…",
    "prefix": "還會帶上這一截：{text}",
    "noPrefix": "只發你這句話：附近/位置數不出來（世界狀態沒拿到）",
    "sentCounted": "已發出 · {role} 好感 {n}（今天第一次跟他説話）",
    "sentOnce": "已發出 · 今天已經跟他聊過了，好感不再加",
    "failed": "沒發出去：{reason}",
    "replyHint": "他的回答在聊天頁（這一屏只發你説的話）",
    "notCurrent": "先不替你發：「{name}」不是當前對話角色，這句話會發給「{who}」。",
    "notCurrentNoWho": "先不替你發：現在沒有正在對話的角色（瀏覽器預覽裏沒有角色數據）—— 這句話發不出去。",
    "toChat": "去聊天頁選 ta",
    "entry": "💬 走近説話",
    "entryTitle": "你離「{name}」約 {m} 米 —— 點一下在地圖上説句話"
  },
  "me": {
    "title": "我的面板",
    "avatar": "我的頭像",
    "avatarUpload": "上傳頭像",
    "avatarChange": "更換頭像",
    "avatarReset": "恢復默認",
    "avatarResetDone": "已恢復默認頭像",
    "avatarSaved": "頭像已保存",
    "avatarTooLarge": "圖片太大了（壓到 256px 還是超過 1.4MB），換一張小點的試試",
    "avatarBad": "這張圖讀不出來，換一張試試",
    "avatarHint": "圖片會先壓到 256px 再存到本機（localStorage），只在這台設備的「世界模擬」裏使用。",
    "location": "我的位置",
    "timeWeather": "時間與天氣",
    "time": "當前時間",
    "weather": "天氣",
    "minimap": "眾人小地圖",
    "minimapHint": "點誰就選中誰（小地圖不參與地圖的拖動縮放）",
    "todo": "我的日程 / 待辦"
  },
  "trip": {
    "arrivedToast": "{name} 已到達{place}",
    "fastOn": "⚡ 已開到 {n}× 加速",
    "fastOff": "已回到常速",
    "cancelled": "已取消行程",
    "nothingToCancel": "沒有可取消的行程{reason}"
  },
  "err": {
    "offline": "連不上地圖服務（網絡不通或被擋了）",
    "timeout": "地圖服務響應太慢，超時了",
    "toomany": "請求太頻繁，等一下再試",
    "server": "地圖服務出錯了",
    "unknown": "出了點問題"
  },
  "empty": {
    "schedule": "還沒有今天的日程。日程可以從遊戲裏的「日程」設置添加，加完這裏就能看到。",
    "location": "還沒定位到行政區",
    "place": "地點未知",
    "weather": "暫無天氣數據",
    "actors": "地圖上還沒有人",
    "todo": "今天沒有待辦",
    "todoSub": "空着也是一種好日子 —— 想加點什麼的話，去遊戲裏的日程設置看看。"
  },
  "events": {
    "title": "世界事件",
    "empty": "這個世界還很平靜",
    "emptySub": "安靜也是一種好日子 —— 有事發生時，這裏會一條條記下來。",
    "refresh": "刷新",
    "channel": {
      "bubble": "地圖氣泡",
      "popup": "應用內提示",
      "speech": "角色口述",
      "bubbleHint": "事件發生時，在對應角色的頭像上冒一個氣泡（3~5 秒後消失）",
      "popupHint": "在屏幕底部彈一條提示（好事綠、壞事黃、中性灰）",
      "speechHint": "讓角色在對話裏自然地提一句"
    },
    "channelHint": "角色口述由後端注入實現：事件會進對話的「最近：…」，角色下一輪自然知道。這個開關只控制本面板要不要展示口述提示。",
    "speechPreview": "角色會這樣説",
    "memoryTitle": "待寫記憶",
    "memoryEmpty": "這一次沒有讀到待寫記憶（隊列是空的）",
    "memoryAfter": "隊列裏共 {n} 行（含沒有指定角色的）",
    "memoryHint": "只讀預覽，一行都不取走：這個隊列只有「注入」那條路能消費（行交付給模型之後才劃掉）。前端若也去取，AI 那一輪注入就會靜默少一段——這裏只是把隊列裏現在的行如實顯示出來。",
    "rel": {
      "justNow": "剛剛",
      "minAgo": "{n} 分鐘前",
      "hourAgo": "{n} 小時前",
      "dayAgo": "{n} 天前"
    },
    "state": {
      "idle": "還沒開始（進到小區圖後自動開始）",
      "unsupported": "這個環境沒有事件引擎（瀏覽器預覽）",
      "fired": "剛剛發生了一件事",
      "no_candidate": "引擎醒着，這會兒沒有合適的事件",
      "throttled": "節流中：下次最早 {n} 秒後",
      "no_scene": "世界模擬還沒就位（後端沒收到場景，這時不會產生事件）",
      "unknown": "引擎回了一個不認識的狀態",
      "error": "讀事件出錯：{msg}"
    },
    "category": {
      "weather": "天氣",
      "traffic": "交通",
      "social": "社交",
      "work": "工作學習",
      "health": "健康",
      "money": "消費",
      "accident": "意外",
      "festival": "節日",
      "mood": "情緒",
      "luck": "小確幸",
      "unknown": "事件"
    }
  },
  "bld": {
    "lean": "每格 {n} 棟",
    "many": "樓房 多（不推薦）",
    "leanTitle": "現在：嚴格檔，每個離線包格（約 1km）只畫最重要的 {n} 棟——顯示哪些樓由數據定，縮放平移都不變。點一下切到「多樓房模式」——樓房更多，但明顯更卡，不推薦。",
    "manyTitle": "現在：多樓房模式（不推薦），每格最多畫 {m} 棟（等於不設每格上限，只受總預算約束）。樓房更多，但明顯更卡（低倍視角尤其卡）。點一下切回嚴格檔。"
  },
  "city": {
    "data": "城市數據",
    "title": "選擇城市樓房數據",
    "lead": "首次進入需要下載一座城市的樓房數據（離線包）。裝過就直接進地圖，不再問。",
    "leadInstalled": "已裝：{list} —— 改選 / 重新下載 / 刪除都在下面的列表裏。",
    "leadInstalledNoList": "已裝：{list} —— 已裝的數據不受影響，可以直接進入地圖（可選城市列表狀態見下方）。",
    "source": "下載源",
    "srcUnset": "（未配置：佔位地址，取不到屬預期 —— 在下面填你自己的地址並保存；或用 ?citybase= / 構建期 VITE_WS_CITY_PACK_BASE）",
    "srcFallback": "（下載源覆蓋值不可用、已回落到佔位：{why}；被拒絕的原值 = {requested} —— 改下面輸入框裏的地址，或檢查 ?citybase= / VITE_WS_CITY_PACK_BASE）",
    "baseLabel": "下載源地址",
    "basePlaceholder": "https://你的域名（客户端會拼 /citypacks/…）",
    "baseSave": "保存",
    "baseClear": "清除",
    "baseSaved": "已保存並生效：{base}",
    "baseBad": "這個地址不能用（{why}）—— 現在按佔位地址運行，改好再保存一次",
    "baseCleared": "已清除保存的地址，改用：{base}",
    "baseParamNote": "本次由地址欄的 ?citybase= 指定（優先級最高）—— 這裏保存的值要等去掉那個參數後才生效",
    "noCityTag": "未裝城市數據",
    "noCity": "未裝城市數據 · 點這裏選",
    "loading": "正在讀取城市清單…",
    "listed": "可用城市",
    "retry": "重試",
    "enterAnyway": "仍然進入地圖",
    "enterAnywayHint": "清單取不到也能進：地圖會用已經裝好的包；一個都沒裝時，樓房數據可能是空的。",
    "enterSkip": "先不裝，直接進入地圖",
    "unknown": "數不出來",
    "empty": "清單裏沒有任何城市（這是清單給出的答案，不是讀取失敗）",
    "dropped": "清單裏有 {n} 條記錄不可用（已忽略）",
    "size": "包 {s}",
    "cells": "{n} 格",
    "features": "{n} 個要素",
    "attr": "含署名",
    "defaultTag": "默認",
    "installedTag": "已裝",
    "installedLine": "已裝 {n} 格 · {got}",
    "installedNone": "已裝：0 個城市（已量）",
    "installedSummary": "已裝：{list}",
    "shaOk": "sha256 已校驗",
    "shaNone": "清單沒給 sha256（未校驗）",
    "download": "下載並進入",
    "redownload": "重新下載",
    "remove": "刪除",
    "stageDownload": "下載中",
    "stageVerify": "校驗 sha256",
    "stageUnpack": "解包",
    "stageStore": "寫入",
    "gotOfTotal": "已下載 {got} / {total}",
    "gotNoTotal": "已下載 {got} · 總大小未知",
    "failed": "失敗"
  }
};
