# INSTRUCTIONS FOR AI

このファイルはコードベースの設計・仕様をAIエージェント向けにまとめたドキュメントです。

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

| id         | group    | expect                           | 推奨設定                   |
|------------|----------|----------------------------------|----------------------------|
| standard   | safe     | `{ kind: 'safe' }`               | なし（デフォルト）         |
| extreme    | incident | `{ kind: 'eject', cause: 'gz' }` | `restraint: 'lapbar'`      |
| oval       | safe     | `{ kind: 'free' }`               | なし（デフォルト）         |

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
| `gloc`      | `gloc` が出て、`eject` / `derail` は出ない                                             |
| `free`      | 常にPASS（判定なし）                                                                   |

すべての期待結果が一致すれば終了コード `0`、1つでも失敗すれば `1` で終了する。
