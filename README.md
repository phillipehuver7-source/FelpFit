# FelpFit para iOS

Aplicativo iOS do FelpFit. A interface web mais recente fica embutida no app e roda em uma `WKWebView` nativa, em tela cheia, com armazenamento local persistente.

## O que está incluído

- Projeto iOS em Swift para iPhone (iOS 15 ou mais recente)
- Interface completa do FelpFit embarcada no aplicativo
- Persistência de login, perfil, rotina, conquistas e configurações via armazenamento local
- Compatibilidade com links, alertas e prompts usados pelo FelpFit
- Build automático de um arquivo `FelpFit-unsigned.ipa` pelo GitHub Actions

## Gerar o IPA sem Mac

Cada push na branch `main` executa o workflow **Build FelpFit IPA**. Ao terminar, o arquivo fica disponível nos artefatos da execução com o nome `FelpFit-unsigned-ipa`.

O IPA é gerado sem assinatura. O instalador usado no iPhone precisa assinar o arquivo antes da instalação.

## Estrutura

```text
FelpFit/
  AppDelegate.swift
  FelpFitViewController.swift
  Info.plist
  Web/
    index.html
    manifest.webmanifest
project.yml
.github/workflows/build-ipa.yml
```

O projeto Xcode é gerado a partir de `project.yml` com XcodeGen para evitar arquivos de projeto dependentes de uma máquina específica.
