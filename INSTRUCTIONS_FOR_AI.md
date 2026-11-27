# INSTRUCTIONS FOR AI

このファイルはコードベースの設計・仕様をAIエージェント向けにまとめたドキュメントです。

---

## 5. 立体要素の作り方

### 5.1 共通の仕組み（SegmentElement）

`coasterTrack.ts` の `SegmentElement` は、線路の向きを「距離に対するピッチ・ヨー・ロールの変化」で積分して作る立体要素の共通の仕組み。

```ts
type ElementSegment = {
  length: number;   // この区間の長さ [m]
  pitch?: number;   // ピッチ変化量 [deg]（上向きが正）
  yaw?: number;     // ヨー変化量 [deg]（左向きが正）
  roll?: number;    // ロール変化量 [deg]（時計回りが正）
};

type SegmentElement = {
  type: 'segment';
  from: string;         // 入口ウェイポイントのラベル
  to: string;           // 出口ウェイポイントのラベル
  segments: ElementSegment[];
  heartline?: number;   // ハートラインの高さ [m]（デフォルト 1.1）
  label?: string;       // 上から見た図に表示するラベル
};
```

#### 積分の仕組み

- 入口の向き（tan / nor / bin）から始め、各区間で向きの変化を **sin² カーブ**（曲率が区間の両端でゼロになる）でなめらかに加えながら、0.5m ステップで位置を積分する
- ピッチ：bin 軸まわりに tan と nor を回転
- ヨー：nor 軸まわりに tan と bin を回転
- ロール（**ハートラインロール**）：乗客のハートライン位置（線路から nor 方向へ heartline m）を軸に回転する。ロール中に線路の位置が heartline 分だけ円弧上を移動することで、乗客の体の中心（胸付近）が回転軸になる

生成した点列は CatmullRom のコントロールポイントに差し込まれ（ループ要素と同じ仕組み）、前後 3 点をブレンドして接続をなめらかにする。

要素区間内の法線（nor）は平行輸送で再計算される（ループ区間と同じ処理）。

#### CourseDesign への組み込み方

```ts
// 例：ゼロGロール
{
  waypoints: [
    // ...
    [x0, z0, h, sigma, 'zgroll-in'],   // 要素入口
    [x1, z1, h, sigma, 'zgroll-out'],  // 要素出口（平面コース上の位置）
    // ...
  ],
  elements: [
    {
      type: 'segment',
      from: 'zgroll-in',
      to: 'zgroll-out',
      segments: zeroGRoll(40),
      label: 'ゼロGロール',
    }
  ],
}
```

#### バンクの扱い

SegmentElement の区間は、`inLoop()` が `true` を返すためバンクの自動付与の対象外になる（ロールが入るため、速度プロファイルからバンクを決める計算が意味を持たない）。

---

### 5.2 要素プリセット

プリセット関数は `src/components/simulator/presets.ts` に定義されており、`ElementSegment[]` を返す。

#### `zeroGRoll(length, pitchDeg?)`

小さな丘の頂上で 360° ロールする要素。頂上付近で上下 G が 0 に近くなる高さ・長さにする。

| パラメータ | 説明 | 推奨値 |
|---|---|---|
| `length` | 全体の長さ [m] | 25〜35 |
| `pitchDeg` | 上り半分でのピッチ変化 [deg] | 35〜50（大きいほど丘が高い） |

```ts
// 長さ 30m のゼロGロール
zeroGRoll(30)       // pitchDeg のデフォルト 42°
zeroGRoll(30, 40)   // pitchDeg を明示指定
```

#### `ravenTurn(side, radius)`

半ループ（ピッチ 180°）＋半ひねり（ロール 180°）を組み合わせ、進む向きを 180° 変える要素。

| パラメータ | 説明 |
|---|---|
| `side` | `'inside'`：乗客がループの内側から上る（下→上→逆さ）。`'outside'`：ロール方向を逆に |
| `radius` | ループ半径 [m]（推奨 12〜20） |

```ts
ravenTurn('inside',  14)  // インサイドレイブンターン、半径14m
ravenTurn('outside', 14)  // アウトサイドレイブンターン
```

#### `verticalClimb(length, maxPitchDeg?)` / `verticalDrop(length, maxPitchDeg?)`

ピッチを最大傾斜まで立てて上る・下る区間。

| パラメータ | 説明 | 推奨値 |
|---|---|---|
| `length` | 区間全長 [m] | 高さ÷sin(maxPitchDeg)×1.5 程度 |
| `maxPitchDeg` | 最大傾斜角 [deg] | 85〜90 |

```ts
verticalClimb(25)       // 垂直上昇（最大87°）
verticalDrop(32, 85)    // 垂直落下（最大85°）
```

---

### 5.3 テストコース（`id: 'test-elements'`）

`presets.ts` の `testElements()` は、ゼロGロール・インサイドレイブンターン・垂直落下を 1 つずつ配置した周回テストコース（Issue #25）。

| 要素 | 入口速度の目安 | 目標 |
|---|---|---|
| ゼロGロール | 70〜80 km/h | ロール中の上下G -0.3〜+0.5、横G ±0.5 以内 |
| インサイドレイブンターン | 80〜90 km/h | 一番上で逆さになり、上下G +0.5 以上（浮かない） |
| 垂直落下 | 巻き上げ頂上から | 最大傾斜 85〜90°、底の上下G 4.5 以下 |

---

## 13. シミュレーターの設計

### 13.1 判定（SimEvent）

`SimEvent`（`src/components/simulator/simEngine.ts`）はシミュレーション中に発生したできごとを表す。

```ts
type SimEventCode =
  | 'start'    // 発車
  | 'lap'      // 1周完了
  | 'eject'    // 乗客が投げ出された
  | 'land'     // 投げ出された乗客が地面に落ちた
  | 'derail'   // 脱線
  | 'car-land' // 脱線した車両が地面に落ちた
  | 'rollback' // 重力区間で後ろへ転がり戻った
  | 'rest'     // 完全に止まった（車両・乗客）
  | 'gloc'     // 乗客が意識を失った（G-induced Loss Of Consciousness）
  | 'recover'; // 乗客が意識を取り戻した

type EjectCause = 'gz' | 'gy' | 'impact';
// gz     : 上下G が拘束装置の限界を超えて浮き上がった
// gy     : 横G が拘束装置の限界を超えて横に振られた
// impact : 車両が地面に衝突した衝撃で飛ばされた

type SimEvent =
  | { t: number; kind: 'info' | 'warn' | 'fail'; code: Exclude<SimEventCode, 'eject'>; text: string }
  | { t: number; kind: 'info' | 'warn' | 'fail'; code: 'eject'; cause: EjectCause; text: string };
```

`code` フィールドはスクリプトによる機械判定に使う。UI表示には `text` を使う。

### 13.4 ひな形（Preset）

`src/components/simulator/presets.ts` にひな形の定義がある。

#### Preset 型

```ts
type PresetExpectation =
  | { kind: 'safe' }                      // 安全に1周できる
  | { kind: 'eject'; cause: 'gz' | 'gy' } // 乗客が投げ出される（原因付き）
  | { kind: 'derail' }                    // 列車が脱線する
  | { kind: 'stall' }                     // 途中で止まる
  | { kind: 'gloc' }                      // 乗客が意識を失う
  | { kind: 'free' };                     // 自由に試せる（判定なし）

type Preset = {
  id: string;
  name: string;
  description: string;
  group: 'safe' | 'incident'; // UIで「安全なコース」「事故の再現」に分けて表示
  design: CourseDesign;
  settings?: Partial<SimSettings>; // 推奨設定（DEFAULT_SETTINGS に重ねて適用）
  expect: PresetExpectation;       // 期待結果（検証スクリプトで使用）
};
```

#### 既存のひな形

| id       | group    | expect                           | 推奨設定                                                       |
|----------|----------|----------------------------------|----------------------------------------------------------------|
| standard | safe     | `{ kind: 'safe' }`               | なし（デフォルト）                                             |
| extreme  | incident | `{ kind: 'eject', cause: 'gz' }` | `restraint: 'lapbar'`                                          |
| derail   | incident | `{ kind: 'derail' }`             | `restraint: 'harness'`                                         |
| family   | safe     | `{ kind: 'safe' }`               | なし（デフォルト）                                             |
| no-bank  | incident | `{ kind: 'eject', cause: 'gy' }` | `banking: false, restraint: 'lapbar'`                          |
| oval     | safe     | `{ kind: 'free' }`               | なし（デフォルト）                                             |
| stall    | incident | `{ kind: 'stall' }`              | なし（デフォルト）                                             |
| airtime  | safe     | `{ kind: 'safe' }`               | なし（デフォルト）                                             |
| figure8  | safe     | `{ kind: 'safe' }`               | なし（デフォルト）                                             |
| gloc     | incident | `{ kind: 'gloc' }`               | `restraint: 'harness'`, `frictionScale: 0.1`, `dragScale: 0.1` |

##### `stall` ひな形の設計メモ

- 巻き上げ頂上（実際約18m）から1つ目の丘（実際約13m）を越え、2つ目の丘（実際約22m）で力尽きて転がり戻る
- 2つ目の丘は巻き上げより3m以上高く、1つ目の丘は巻き上げより低くして通過できる配置
- 2つ目の丘への長いアプローチ（高速直線区間）で摩擦損失が大きく、実際の失速高は約15m
- 転がり戻った後は lift 〜 hill1 間の低空飛行区間（free ゾーン）で自然に停止する
- station ゾーンに戻らないよう、1つ目の丘がバリアになっている（往路は通過可、復路は通過不可）



#### エアタイムヒルズ（airtime）の設計メモ

標準コースをベースに直線 3 丘を組み込んだコース。

- 巻き上げ 36m は維持（エネルギー確保）
- 西側 U ターン後の z=30 直線（x=-85〜x=-12）に丘 2 つを配置
- 3 つ目の丘は S 字カーブ（元の標準コースのものを再利用）で代替
- ヘリックスを標準の 1.5 周（-540°）→ 0.5 周（-180°）に短縮してエネルギーを節約
- U ターン出口（x=-85）からトリムブレーキを開始（45m の制動距離）
- トリム速度 17 m/s（好条件での頂上 G が -0.5 G を割らないよう制限）
- 丸め σ=7 で頂上の G が標準条件で -0.3〜-0.4 G 程度のエアタイムを実現

**設計上の落とし穴**：
- 丘の頂上は直線（z=30 ライン）に置く（カーブ上に置くとバンクで横 G を打ち消せないため）
- トリムゾーンは U ターン出口から始め、十分な制動距離（少なくとも 40m）を確保する
- S 字カーブ前の速度は trim（ヘリックス手前、speed=16 m/s）が担保する
- ヘリックスを短縮するとクリアランスが大きくなる（標準の 1.5 周では線路が重なる）
#### derail コースの設計ポイント

標準コースのキャメルバック（点17付近）を「高さ18m・丸め（σ）1m」に作り替えることで脱線を再現する。

- トリムブレーキをすべて外し、キャメルバックの手前で速度が落ちないようにする
- 高さを低くすることで頂上の速度が上がり（目標 ≥ 45km/h）、上下G が -4.9 程度まで落ちる
- ショルダーハーネス（`restraint: 'harness'`）では -2.5G で投げ出し、補助輪の限界 -3G で脱線する
- 期待されるログの順: `eject`（ハーネスの限界 -2.5）→ `derail` → `car-land` → `land`

#### ファミリーコース（family）の設計基準

巻き上げ 12.5m・全長 ~481m・最高速 50km/h 以下の家族向けコース。

| 項目             | 目標              | 実測（標準・悪・好条件）                   |
|------------------|-------------------|--------------------------------------------|
| 巻き上げ高さ     | 12〜15m           | 12.5m                                      |
| 全長             | 300〜500m         | ~481m                                      |
| 最高速度         | ≤50km/h（3条件）  | 47.1 / 45.1 / 49.4 km/h                   |
| 上下G            | 0.2〜2.5（3条件） | 0.80〜1.13 / 0.88〜1.10 / 0.71〜1.17      |
| 横G              | <0.3（安全基準）  | 0.15 / 0.12 / 0.25                         |
| 1周の時間        | 60〜90秒（3条件） | 76s / 86s / 69s                            |

レイアウト: 細長いD字形。駅から南へ直進して巻き上げ→ファーストドロップ→U ターン（右側・大半径）→北上しながら丘×3→ブレーキ→駅に戻る。ヘリックス・交差なし。

##### no-bank（バンクなしカーブ）

標準コースをベースに、谷直後の半径35m Uターンを半径20m に差し替えたコース。
バンクなしで約85km/h で急カーブに入ると横G≈2.5G となり、ラップバーの限界（±1.8G）を超えて乗客が横に投げ出されます。
バンクをオンにすると設計速度でバンク角が付き横Gが打ち消されるため、安全に1周できます。

**追加チェック（`validatePresets.ts`）**: `banking: true` にした場合、 `eject` と `derail` が0件で1周完了することを自動確認する。

#### figure8 コースの設計ポイント

右半円（CW）と左半円（CCW）が交差部 (0,0) 付近で立体交差する縦型8の字。

- **交差部** : 右半円を h=14 で南行き通過（高交差）、左半円前に h=2 で南行き通過（低交差）。高低差 12m でクリアランスを確保。
- **lift** : 駅を北側（z=-120）に配置し、南向きで交差部に進入することで U ターンを防ぐ。
- **右半円** : `helix(60, 0, 60, 180, -180, 14, 12, 11)` — h=14→12 で 1 周の半分を CW 周回（南行き entry、北行き exit）。
- **左半円** : `helix(-60, 20, 60, 0, 180, 2, 2, 11)` — h=2 一定で 1 周の半分を CCW 周回（南行き entry、北行き exit）。
- **trim** : 右半円後に北方向経由で西へ（speed: 16 m/s）。左半円前に trim2 で 12 m/s に制限して横 G を抑制。
- **brake/station** : ブレーキ区間は短く（約 5m）し、速度が低い悪条件でも station zone に到達できるよう設計。
- **線路どうしの最短距離** : 交差部の高低差 12m により 12m 以上を確保（安全基準 4m 以上）。

**gloc の設計メモ**

- 標準コースの 1.5 周ヘリックスを **半径 9m** に差し替え、手前トリムを **22 m/s** に設定する。
- バンクが横 G を上下 G に変換し、ヘリックス全体で **G 4.8〜5.5** が維持される。
- `frictionScale: 0.1` / `dragScale: 0.1` で空気・摩擦抵抗を抑え、速度を維持させる（通常摩擦だとヘリックス内で速度が落ちすぎて G が閾値に届かない）。
- `glocGz = 4.5` を **2 秒以上** 超えると `gloc` → ヘリックスを抜けると `recover` が発生する。

#### UI での表示

- ひな形一覧は `group` ごとに「安全なコース」「事故の再現」のセクションに分けて表示する
- ひな形を選択すると `DEFAULT_SETTINGS` に `settings` を重ねて適用する
- 説明文の下に `EXPECT_LABEL[expect.kind]` で「何が起きるか」を1行で表示する
- 推奨設定が適用されたときは「車両と装置」タブの該当項目に ★ を表示し、適用中である旨の注記を出す

### 13.5 検証スクリプト（validatePresets）

`scripts/validatePresets.ts` でひな形の期待結果を自動検証できる。

```sh
npx tsx scripts/validatePresets.ts
```

#### 判定ルール

| expect.kind | 条件                                                                                   |
|-------------|----------------------------------------------------------------------------------------|
| `safe`      | `evaluateCourse` が3条件すべてPASS かつ 300秒以内に `lap` が出て `fail` イベントなし |
| `eject`     | 300秒以内に `eject` が出て、`cause` が `expect.cause` と一致                         |
| `derail`    | 300秒以内に `derail` が出る                                                            |
| `stall`     | `rollback` と `rest` が出て、`eject` / `derail` は出ない                               |
| `gloc`      | `gloc` が出て、その後 `recover` が出て、`eject` / `derail` は出ない                   |
| `free`      | 常にPASS（判定なし）                                                                   |

すべての期待結果が一致すれば終了コード `0`、1つでも失敗すれば `1` で終了する。
