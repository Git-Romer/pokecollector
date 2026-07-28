import {webDarkTheme, webLightTheme} from '@fluentui/react-components'

// Shared across both themes. These carry the values that index.css
// previously forced onto .fui-Button / .fui-Input with !important.
const archiveBase = {
    fontFamilyBase: "'Inter', system-ui, sans-serif",
    borderRadiusMedium: '8px',
}

export const archiveDarkTheme = {
    ...webDarkTheme,
    ...archiveBase,
    colorBrandBackground: '#F58220',
    colorBrandBackgroundHover: '#FF9B4A',
    colorBrandBackgroundPressed: '#C55E10',
    colorBrandForeground1: '#FFB06D',
    colorBrandForegroundLink: '#FFB06D',
    colorNeutralBackground1: '#000000',
    colorNeutralBackground2: '#171513',
    colorNeutralBackground3: '#24201C',
    colorNeutralBackground4: '#302A24',
    colorNeutralForeground1: '#FFFFFF',
    colorNeutralForeground2: '#E9DED4',
    colorNeutralStroke1: '#453D34',
    colorNeutralStroke2: '#302A24',
}

export const archiveLightTheme = {
    ...webLightTheme,
    ...archiveBase,
    colorBrandBackground: '#C55E10',
    colorBrandBackgroundHover: '#A54E0D',
    colorBrandBackgroundPressed: '#7C3909',
    colorBrandForeground1: '#A54E0D',
    colorBrandForegroundLink: '#A54E0D',
    colorNeutralBackground1: '#FFF9F4',
    colorNeutralBackground2: '#FFFFFF',
    colorNeutralBackground3: '#F5EDE6',
    colorNeutralForeground1: '#241E19',
    colorNeutralForeground2: '#594D42',
    colorNeutralStroke1: '#DCCFC2',
}
