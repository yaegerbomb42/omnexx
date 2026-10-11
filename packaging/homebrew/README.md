# Homebrew

`omnexx.rb.in` is the formula template. After a release is on npm, generate the formula and
commit it to the tap repo `yaegerbomb42/homebrew-omnexx` as `Formula/omnexx.rb`:

```sh
scripts/brew-formula.sh 0.5.0 > ../homebrew-omnexx/Formula/omnexx.rb
```

Users then install with `brew install yaegerbomb42/omnexx/omnexx`.
