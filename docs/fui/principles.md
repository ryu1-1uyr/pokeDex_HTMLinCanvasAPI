# FUI 原則 — 「それっぽさ」はどこから来るか

FUI（Fictional / Fantasy User Interface）は映画・ゲームの中に登場する架空の UI。
ここでは「なぜそう作るのか」を原則として残す。具体的なルールは [grammar.md](grammar.md)、
作り方は [patterns.md](patterns.md)、レビュー観点は [checklist.md](checklist.md) を参照。

## P1. FUI はインターフェースではなく「物語の可視化」

FUI という語を広めた Mark Coleran は、映画の UI は操作のための UI ではなく
「いま何が起きているか」を観客に見せるプロット装置だと述べている。

- 本プロジェクトでの物語は **「図鑑がポケモンをスキャンし、解析している」**。
- すべての演出はこの一文に奉仕しているかで判断する。奉仕しない演出は、綺麗でも削る候補。
  - 例: 流体シミュレーションは綺麗だったが「解析」という物語に結びつかず削除した。
  - 例: パーティクル変身は「データを読み取って再構成している」と読めるので残した。

## P2. 主役は 24 フレーム（約 1 秒）で読める

Marvel 作品の FUI デザイナー Robyn Haddow は、主役となるグラフィックは
24 フレーム以内に理解できるべきだとしている。映画では画面を凝視する時間がない。

- 1 画面に主役は 1 つ。主役はシンプルで大きく、高コントラスト。
- 情報密度（マイクロテキスト、目盛り、数値）は **主役の周辺** で上げる。主役に重ねない。
- 本プロジェクトの主役: メイン画面 = アートワーク、ステータス画面 = レーダーの多角形、リスト = 選択行。

## P3. 静止した画面は死んで見える

Coleran は、映画の UI はアニメーションにおいて現実の UI より先を行っていたと語っている。
カメラに映った静止画面は「電源が入っていない」ように見える。

- **一次モーション**: 状態が変わるときの動き（起動、デコード、変身、スナップ）。変化の「過程」を見せる。
- **二次モーション**: 何も起きていないときの微小な動き（揺れる数値、スイープ、点滅）。システムが生きていることを示す。
- 二次モーションは控えめにする。主役の一次モーションを邪魔しない振幅に留める。

## P4. 見慣れたものを誇張する

Coleran は現実の UI（Windows など）を土台にし、それを誇張することで「架空なのに分かる」画面を作ったという。

- 実在する計測機器・UI の文法を借りる: レーダースコープ、オシロスコープ、CRT、照準器、製図の引き出し線。
- 借りた文法は誇張してよいが、意味は変えない（目盛りは測るもの、照準は狙うもの）。

## P5. 装飾にも「機能の設定」を与える

Jayse Hansen はステレオ 3D 撮影ではすべてが鮮明に見えるため、
画面上の要素すべてに機能を持たせる必要があったと語っている。

- 意味のない飾り線を置かない。少なくとも「何を測っている/指している設定か」を決めてから置く。
  - `SIG -42.0dB` は「スキャナの受信強度」、`σ 8.6` は「種族値のばらつき」という設定を持つ。
- 設定が決まっていれば、値の動き方（揺れ幅、更新頻度）も自然に決まる。

## P6. 色とタイポグラフィの慣習

Nathan Shedroff と Chris Noessel の『Make It So』は、SF 映画の UI を調査し、
画面の色は青系が支配的であること、書体はサンセリフが圧倒的に多いことを報告している。

- 青/シアンは自然界に少なく「人工的・非人間的」に見える。ベースインクにする。
- 書体はサンセリフ + 数値用の等幅。セリフ体は使わない。
- 慣習に乗ることで、観客の学習コストをゼロにする（P4 と同じ理由）。

## P7. グラフィックは物語と監督のビジョンに奉仕する

Territory Studio の Peter Eszenyi は、どれだけ美しい UI でも物語を語り、
監督が見たいビジョンを支えなければならないと述べている。

- 本プロジェクトでは「監督」= この図鑑で何を体験させたいか。迷ったら P1 に戻る。

## 参考

資料ごとの要点と原則との対応は [references.md](references.md) にまとめている。

- [Pragmatic futurism and screen graphics – interview with Mark Coleran (Pushing Pixels)](https://www.pushing-pixels.org/?p=18414)
- [Faking good design in film – Wireframe podcast episode 12 (Adobe)](https://xd.adobe.com/ideas/perspectives/wireframe-podcast/faking-good-design-in-film-episode-12)
- [Mark Coleran interview (Gizmodo, Pushing Pixels archive)](https://pushing-pixels.org/coleran/interviews/gizmodo/index.html)
- [The craft of screen graphics and movie user interfaces – interview with David Sheldon-Hicks of Territory Studio (Pushing Pixels)](https://www.pushing-pixels.org/?p=9769)
- [The art and craft of screen graphics – interview with Peter Eszenyi of Territory Studio (Pushing Pixels)](https://www.pushing-pixels.org/?p=13856)
- [The craft of screen graphics and movie user interfaces – conversation with Jayse Hansen (Pushing Pixels)](https://www.pushing-pixels.org/?p=7447)
- [Design of "The Avengers" – interface designs and HUDs (HUDS+GUIS)](https://www.hudsandguis.com/2013/05/15/the-avengers/)
- [Future Screens Are Mostly Blue (99% Invisible)](https://99percentinvisible.org/episode/future-screens-are-mostly-blue/)
- [Not So Strange, These Fictions (UXPA Magazine)](https://oldmagazine.uxpa.org/not-so-strange-these-fictions)
