# nes-game

cc65 でビルドする NES (ファミコン) 用ゲームのプロジェクト。現状は、地図サーバーから z/x/y で地形を受け取って歩き回る世界地図デモ (サーバーがなくても ROM 内の生成で動く)。

## 必要なもの

- [cc65](https://cc65.github.io/) (`cl65` / `ca65` / `ld65`)
- GNU Make
- エミュレータ: [Mesen](https://github.com/SourMesen/Mesen2/releases) (任意。未インストールならデフォルトのアプリで開く)
- サウンド作成: [FamiStudio](https://famistudio.org/) (任意)

cc65 のインストール (macOS):

```sh
brew install cc65
```

必要なツールが揃っているかは次のコマンドで確認できる。

```sh
make doctor
```

## ビルド

```sh
make
```

`build/` に次のファイルが生成される。

- `build/field.nes` : ROM
- `build/field.dbg` : Mesen 用デバッグシンボル

## 起動

```sh
make run
```

ROM をビルドしたうえで、Mesen があれば Mesen で、なければ `.nes` に関連付けられたデフォルトのアプリで開く。
Mesen は `/Applications` または `~/Applications` から探す。

手動で起動する場合は、エミュレータで `build/field.nes` を開く。

## 操作

- 十字キー: 東西南北に 1 マスずつ移動 (エミュレータの既定キーは矢印キー)
- A: ズームイン / B: ズームアウト (z=1..20)
- マス: 草原・山・森・橋・道路は通行可、水・岩山は通行不可。極の先 (y の範囲外) は岩で進めない
- 画面はプレイヤーを中心に滑らかにスクロールする

## 座標と地図サーバー

- 世界の 1 辺は 2^(z+4) マス (1 タイル = 16x16 マス)。座標は 24bit (3 バイト) + z で持つ。x は経度方向に巻き戻る。
- NES は z、タイル x/y、タイル内のマス位置、方向と長さを送り、地形 ID の並びを受け取る (仕様は `server/mapserver.py` の先頭)。
- 通信はコントローラポート 2 の同期式シリアル (`src/link.c`)。`$4017` の読み出しがクロックで、
  NES から相手へはラッチ線 (`$4016` bit0)、相手から NES へは D0 で送る。ボーレートの調整は要らない。
  実機では Raspberry Pi Pico がこの相手になる想定 (Pico と Pi は USB シリアル / TCP)。
- 応答がなければ ROM 内の手続き生成 (`src/worldgen.c`) に自動で切り替わる。

### エミュレータでサーバーにつなぐ

1. Mesen のスクリプトウィンドウの設定で "Allow network access" を有効にする (一度だけ)。
2. `make server` でサーバーを起動する。
3. 別ターミナルで `make bridge` を実行する。`mesen/bridge.lua` がシリアルを TCP に中継する。

`make test` でサーバーのテストを実行する。現状の地形は `server/mapserver.py` のノイズで作った仮の世界で、
実際の地図 (タイル画像の分類など) への差し替えは `SyntheticSource` を置き換える。

## 仕組み

- VRAM は 4 画面ミラー (32x30 マスの輪)。歩くたびに進行方向の端の 1 行/列だけを描き足す。
  実機では拡張 VRAM を持つカートリッジが必要 (エミュレータでは問題ない)。
- vblank の時間は短いので、描画内容は vblank の外でキュー (`queue`) に積み、vblank では `src/ppu.s` の `flush_cells` で一気に書く。
- タイル絵は `gfx/gen_chr.py` で `gfx/tiles.chr` に生成する (`make` が自動で実行)。

## クリーン

```sh
make clean
```

## make ターゲット一覧

| ターゲット | 内容 |
| --- | --- |
| `make` / `make all` | ROM とデバッグシンボルをビルド |
| `make run` | ビルドしてエミュレータで起動 |
| `make clean` | `build/` と `src/*.o` を削除 |
| `make doctor` | 推奨ツールの導入状況を確認 |

使用するツールは変数で差し替えできる (例: `make CL65=/path/to/cl65`)。

## ディレクトリ構成

```
.
├── Makefile      ビルド定義
├── server/       地図サーバー (Python、標準ライブラリのみ) とテスト
├── mesen/        Mesen 用ブリッジ (bridge.lua)
├── cfg/          リンカ設定 (field.cfg)
├── src/          crt0.s (起動) / main.c (ゲーム本体) / ppu.s (PPU 書き込み) / link.c (地図サーバーとの通信) / worldgen.c (地形生成) / chr.s (CHR 取り込み)
├── gfx/          gen_chr.py と生成された tiles.chr
├── audio/        サウンド素材 (FamiStudio の出力など)
├── build/        ビルド成果物 (git 管理外)
└── .vscode/      エディタ設定 (VS Code / Cursor)
```

## エディタ

VS Code / Cursor を想定している。

- 推奨拡張: `tlgkccampbell.code-ca65` (ca65 アセンブラのシンタックスハイライト)
- ビルドタスク: `Cmd+Shift+B` で `make` を実行
