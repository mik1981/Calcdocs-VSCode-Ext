# 🧮 CalcDocs — Instantly See What Your Firmware REALLY Computes [0.3.5-*prerelease*]

<p align="center">
  <b>Reveal hidden firmware values directly inside VS Code.</b><br>
  Inline calculations • Macro value expansion • Engineering formulas • Unit conversions<br><br>
  <b>Live engineering knowledge embedded directly into firmware.</b><br>
  <b>Stop rebuilding firmware formulas in Excel ➡️ Reuse the originals directly.</b>
</p>

---

[![Version](https://vsmarketplacebadges.dev/version-short/convergo-dev.calcdocs-vscode-extension.svg)](https://visualstudio.com)
[![Download](https://vsmarketplacebadges.dev/downloads-short/convergo-dev.calcdocs-vscode-extension.svg)](https://visualstudio.com)
[![License](./resources/license-badge.png)](./LICENSE.md)

> Firmware logic is often invisible.
>
> Values are buried behind:
> - chained macros
> - scaling constants
> - unit conversions
> - spreadsheet calculations
> - scattered documentation
>
> 👉 **CalcDocs makes those values visible instantly.**

---

## ⚡ What CalcDocs does

CalcDocs transforms VS Code into a **live firmware calculation explorer**.

Instead of manually expanding macros, opening Excel files, or mentally resolving formulas:

✅ Hover a value  
✅ See the final computed result  
✅ Understand firmware logic instantly

No build.
No flashing.
No debugger.

---

## ⚡ 5-second demo

---


## 1️⃣ Coding Evaluator

Write this:

```c
#define RPM 1000
#define SPEED (RPM * 0.10472)
```

CalcDocs instantly shows:

```c
#define SPEED (RPM * 0.10472)   ← 104.72
```

✅ Real-time evaluation  
✅ Inline resolved values  
✅ No manual calculations  

---

## 2️⃣ Realtime Engineering Notes

Write this directly inside your firmware comments:

```c
// @rpm = 3000 rpm
// = @rpm -> rad/s
// = 13 N * 1 m * @rpm -> W
```

CalcDocs evaluates everything live:

```c
// @rpm = 3000 rpm
// = @rpm -> rad/s <- 314.1592653589793 rad/s
// = 13 N * 1 m * @rpm -> W <- 4084.0704496667313 W
```

* Realtime calculations directly in comments
* Unit conversion (`rpm -> rad/s`, `atm -> Pa`, etc.)
* Keep formulas near the actual firmware logic
* Eliminate scattered Excel and text notes


---

> Keep engineering calculations close to the firmware logic instead of:
> - Excel sheets
> - random `.txt` files
> - disconnected documentation
>
> Your firmware becomes self-documented.

---

## 3️⃣ Interactive Formula Explorer

Explore firmware formulas as a live dependency graph directly inside VS Code.

![Macro Chain Revelation in code](./resources/interactive_formula_viewer.gif)

CalcDocs keeps formulas and firmware intrinsically synchronized.

The same engineering logic can now:

✅ live next to production code  
✅ be evaluated in real time  
✅ be reused during debugging  
✅ propagate through dependencies automatically  
✅ stay permanently aligned with the firmware implementation  
✅ can also propagate **tolerances** (e.g. `tol`, `min`/`max`) through your YAML formula dependency graph to compute final **min/max ranges**.

No duplicated engineering logic.  
No spreadsheet drift.  
No parallel maintenance.  

---

## 4️⃣ Macro Chain Revelation

| File | Preview |
| :---: | :---: |
| Inside ***C code*** | ![Macro Chain Revelation in code](./resources/macro_chain_revelation_code.gif) |
| Inside **formulas\*.yaml** | ![Macro Chain Revelation in formulas](./resources/macro_chain_revelation_formulas.gif) |

---

# 👀 Firmware Blindness — Before vs After

| Before | After |
| :---: | :---: |
| ![Before](./resources/firmware_blindness_before.png) | ![After](./resources/firmware_blindness_after.png) |

---

# ⚡ Quick Actions & Header Generation

| Header generation |
| :---: |
![Macro and constant generation header output](./resources/generate_header.gif) |  

| Quick menu |
| :---: |
| ![Quick menu](./resources/quick_menu.png) |

---

# 🔥 Why this matters

Firmware development is rarely difficult because of syntax.

It becomes difficult because:

- values are hidden
- formulas are fragmented
- scaling is implicit
- engineering decisions live outside the codebase

Understanding a single value may require:

- opening multiple headers
- expanding macro chains
- checking documentation
- validating unit conversions
- searching old spreadsheets

---

> Most firmware projects suffer from:
> - duplicated formulas
> - stale spreadsheets
> - undocumented scaling
> - hidden assumptions
>
> These issues create real bugs.

---

## CalcDocs removes that friction.

Instead of navigating half the project:

👉 you immediately see what the firmware computes.

---

## 🔗 YAML ↔ C Synchronization

Define formulas once:

```yaml
power:
  formula: vin * current
  unit: W
```

Use them everywhere.

CalcDocs:

✅ evaluates formulas  
✅ syncs YAML with C/C++  
✅ prevents formula drift  
✅ shows results inline  

---

## ⚖️ Built-In Validation

Detect issues early:

- Unit mismatches
- Overflow risks
- Invalid conversions
- YAML/C inconsistencies

---

> CalcDocs is designed for real embedded firmware workflows.

---

## 👀 What it looks like in real code

```c
#define VIN 24
#define CURRENT 2
#define POWER (VIN * CURRENT)
```

CalcDocs shows:

```c
#define POWER (VIN * CURRENT)   ← 48W
```

---

## 💡 Real use cases

### 🔍 Understand code instantly

No more jumping across headers to resolve macros

### ⚠️ Catch bugs early

See wrong values before flashing your MCU

### 🔄 Eliminate Excel drift

Formulas stay aligned with firmware

### 🧪 Debug faster

Know values before runtime

---

## 📚 Create Self-Documenting Firmware

Engineering decisions stay inside the source code.

---

# ❗ What CalcDocs Is NOT

CalcDocs is intentionally focused.

It is:

❌ NOT a compiler  
❌ NOT a debugger  
❌ NOT a full static analyzer  

---

> CalcDocs focuses on one thing:
>
> **making firmware numeric logic visible.**

---

## ⚙️ Recommended setup (optional)

CalcDocs works standalone.

For best results, combine it with:

- `clangd` *(recommended)*
- `ms-vscode.cpptools`
- `CMake Tools`

CalcDocs integrates without conflicts.

---

> CalcDocs supports engineering prefixes automatically:
>
> `mV`, `uV`, `nV`, `kV`, `MHz`, `mA`, etc.

---

## ❤️ Support

If CalcDocs saves you time:

- ⭐ **Leave a review** (this helps a lot)  
  https://marketplace.visualstudio.com/items?itemName=convergo-dev.calcdocs-vscode-extension

- 💖 Support development  
  [![PayPal](https://img.shields.io/badge/PayPal-Support-blue?logo=paypal&logoColor=white)](https://www.paypal.me/gianmichelepasinelli)

---

## 📚 Documentation

Full documentation available on GitHub:

- 👉 [Getting Started](https://github.com/mik1981/Calcdocs-VSCode-Extension/blob/main/docs/getting-started.md)
- 👉 [Formula YAML Guide](https://github.com/mik1981/Calcdocs-VSCode-Extension/blob/main/docs/formulas-yaml.md)
- 👉 [Real Use Cases](https://github.com/mik1981/Calcdocs-VSCode-Extension/blob/main/docs/use-cases.md)
- 👉 [Features Overview](https://github.com/mik1981/Calcdocs-VSCode-Extension/blob/main/docs/features.md)
- 👉 [Configuration](https://github.com/mik1981/Calcdocs-VSCode-Extension/blob/main/docs/configuration.md)
- 👉 [Architecture](https://github.com/mik1981/Calcdocs-VSCode-Extension/blob/main/docs/architecture.md)
- 👉 [Limitations](https://github.com/mik1981/Calcdocs-VSCode-Extension/blob/main/docs/limitations.md)
- 👉 [Contributing](https://github.com/mik1981/Calcdocs-VSCode-Extension/blob/main/docs/contributing.md)
- 👉 [Inline Calculations](https://github.com/mik1981/Calcdocs-VSCode-Extension/blob/main/docs/inline-calculations.md)
- 👉 [Interactive Formula Viewer](https://github.com/mik1981/Calcdocs-VSCode-Extension/blob/main/docs/interactive-formula-viewer.md)
- 👉 [Tolerance propagation & formula ranges](https://github.com/mik1981/Calcdocs-VSCode-Extension/blob/main/docs/tolerance-and-ranges.md)

---

## 🧠 Final thought

Spreadsheets hide logic.
Code hides values.

# **CalcDocs reveals both.**

