# nes-game

cc65 でビルドする NES (ファミコン) 用ゲームのプロジェクト。現状は画面に "HELLO NES" を表示するだけの最小構成。

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

- `build/hello.nes` : ROM
- `build/hello.dbg` : Mesen 用デバッグシンボル

## 起動

```sh
make run
```

ROM をビルドしたうえで、Mesen があれば Mesen で、なければ `.nes` に関連付けられたデフォルトのアプリで開く。
Mesen は `/Applications` または `~/Applications` から探す。

手動で起動する場合は、エミュレータで `build/hello.nes` を開く。

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
├── src/          ソースコード (エントリポイント: src/main.c)
├── gfx/          グラフィック素材 (CHR タイルなど)
├── audio/        サウンド素材 (FamiStudio の出力など)
├── build/        ビルド成果物 (git 管理外)
└── .vscode/      エディタ設定 (VS Code / Cursor)
```

## エディタ

VS Code / Cursor を想定している。

- 推奨拡張: `tlgkccampbell.code-ca65` (ca65 アセンブラのシンタックスハイライト)
- ビルドタスク: `Cmd+Shift+B` で `make` を実行
