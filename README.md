# nes-game

cc65 でビルドする NES (ファミコン) 用ゲームのプロジェクト。現状は現代の街道を歩いて回る、無限に広がるフィールド移動デモ。

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
- マス: 草原・山・森・橋・道路は通行可、水・岩山は通行不可
- 画面はプレイヤーを中心に滑らかにスクロールし、フィールドは 16bit 座標の範囲で続く
- 32 マスおきに道路が走り、水の上は橋になる。起動位置は道路の交差点

## 仕組み

- VRAM は 4 画面ミラー (32x30 マスの輪)。歩くたびに進行方向の端の 1 行/列だけを描き足す。
  実機では拡張 VRAM を持つカートリッジが必要 (エミュレータでは問題ない)。
- 地形は `src/link.c` の `link_fetch()` で取得する。いまは `src/worldgen.c` の手続き生成で代用しており、
  ここを外部 (Raspberry Pi) との通信に差し替える想定。
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
├── cfg/          リンカ設定 (field.cfg)
├── src/          crt0.s (起動) / main.c (ゲーム本体) / ppu.s (PPU 書き込み) / link.c (外部取得の窓口) / worldgen.c (地形生成) / chr.s (CHR 取り込み)
├── gfx/          gen_chr.py と生成された tiles.chr
├── audio/        サウンド素材 (FamiStudio の出力など)
├── build/        ビルド成果物 (git 管理外)
└── .vscode/      エディタ設定 (VS Code / Cursor)
```

## エディタ

VS Code / Cursor を想定している。

- 推奨拡張: `tlgkccampbell.code-ca65` (ca65 アセンブラのシンタックスハイライト)
- ビルドタスク: `Cmd+Shift+B` で `make` を実行
