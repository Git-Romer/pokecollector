import {webDarkTheme} from '@fluentui/react-components'

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
